import { SourceSnapshotFullRecheckEmptyError } from '../platform/source-snapshot-activation';
import {
  validateScanCheckpointSummary,
  type ScanCheckpointSummary,
} from '../platform/scan-checkpoint-summary';
import { createScanPublisher } from '../discovery/scan-publisher';
import {
  validateBoundedScanResumePlan,
  type BoundedScanResumePlan,
} from '../application/bounded-scan-resume';
import type { createBoundedScanResumeService } from '../application/bounded-scan-resume-service';
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
import {
  isScanPreparationFailureCode,
  type ScanPreparationFailureCode,
} from '../discovery/selection-failure';
import type {
  ScanCheckpoint,
  SavedScanCheckpoint,
  ScanCheckpointMutation,
} from '../discovery/scan-checkpoint';
import { checkScanCandidates, checkOwnedScanCandidates } from '../discovery/automatic-check';
import type { ReconciliationScope } from '../catalog/parser';
import type { ChannelCandidate, ParsedPlaylist, Source } from '../catalog/parser';
import { type HealthObservation } from '../discovery/health';
import type { ReviewedScanHealthContext } from '../discovery/prepare-selection';
import type {
  SavedHealthPage,
  SavedHealthQuery,
  SavedHealthRow,
} from '../application/health-history';
function checkEvidence(evidence: SavedHealthRow['evidence']): string {
  switch (evidence.kind) {
    case 'http':
      return `HTTP ${evidence.status}. ${evidence.contentRecognized ? 'Recognized response content; playback was not tested.' : 'Response received; playback was not tested.'}`;
    case 'recognized-media-response':
      return 'Recognized media response; playback was not tested.';
    case 'decoded':
      return `Decoded frames ${evidence.before.decodedFrames} → ${evidence.after.decodedFrames}; ${evidence.after.width} × ${evidence.after.height}; observed for ${evidence.elapsedMilliseconds} ms.`;
    case 'timeout':
      return 'The check reached its time limit; this does not prove the stream is broken.';
    case 'slow':
      return 'No answer within 3 seconds; checked again later in the background.';
    case 'host-down':
      return 'Not requested: earlier checks in this scan could not reach this site. Checked again on a later day.';
    case 'unsupported':
      return 'This device could not support the checked response.';
    case 'canceled':
      return 'The check was canceled.';
    case 'local-network-unavailable':
      return 'The local network was unavailable.';
    case 'network-failure':
      return 'The network request did not finish successfully.';
    case 'not-checked':
      return 'No check was performed.';
  }
}
export type HealthCheckBudgetMs = 20000 | 45000 | 60000;
import {
  createCollectionPipeline,
  stagePipelineSelection,
  type GuideEnrichment,
  type PipelineReview,
  type RegisteredGuide,
} from '../discovery/pipeline';
import {
  scanConfiguredSources,
  stageScanSelection,
  scanReconciliationScopes,
  type ReviewCandidate,
  type ScanReview,
  type ScanSource,
  type StagedScanSelection,
} from '../discovery/scan';

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
function freezeCapture<T>(value: T, seen = new WeakSet<object>()): T {
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
class ContinueRefusal extends Error {
  constructor(readonly reason: ScanResumeRefusal) {
    super('Saved scan cannot continue.');
  }
}
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
function normalizedScanQuery(value: string): string {
  if (typeof value !== 'string' || value.length > 256) throw new Error('Scan query is invalid.');
  const query = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (query.length > 256) throw new Error('Scan query is invalid.');
  return query;
}
export type AutomaticScanEntry = 'fresh' | 'unfinished' | 'completed' | 'unavailable' | 'running';

export function mountSourceScan(
  container: HTMLElement,
  host: SourceScanHost,
  _options: Record<string, never> = {},
): {
  open(sources?: readonly ScanSource[]): void;
  start(sources?: readonly ScanSource[]): void;
  reviewFile(source: Source, file: File): Promise<void>;
  prepareAutomaticEntry(): Promise<AutomaticScanEntry>;
  presentSavedSummary(summary: ScanCheckpointSummary, expectedGeneration: number): boolean;
  startAutomatic(sources?: readonly ScanSource[], options?: AutomaticScanOptions): void;
  refreshAutomatic(sources?: readonly ScanSource[], options?: AutomaticScanOptions): Promise<void>;
  rescanAutomatic(sources?: readonly ScanSource[], options?: AutomaticScanOptions): void;
  continueAutomatic(options?: Pick<AutomaticScanOptions, 'presentation'>): Promise<void>;
  stopAutomatic(): Promise<void>;
  readonly automaticQuery: string;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  dispose(): Promise<void>;
  snapshot(): Readonly<SourceScanSnapshot>;
} {
  const button = (label: string, action: () => void) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', action);
    return element;
  };
  const trigger = button('Scan sources', () => open());
  const dialog = document.createElement('dialog');
  dialog.className = 'source-scan-dialog';
  dialog.setAttribute('aria-label', 'Review source scan');
  const heading = document.createElement('h2');
  heading.textContent = 'Find channels';
  const queryLabel = document.createElement('label');
  queryLabel.textContent = 'Channel or category';
  const query = document.createElement('input');
  query.type = 'search';
  query.maxLength = 256;
  queryLabel.append(query);
  const checkBudgetLabel = document.createElement('label');
  checkBudgetLabel.textContent = 'Channel check time';
  const checkBudget = document.createElement('select');
  checkBudget.setAttribute('aria-label', 'Channel check time');
  for (const [value, label] of [
    ['20000', '20 seconds'],
    ['45000', '45 seconds'],
    ['60000', '60 seconds'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    checkBudget.append(option);
  }
  checkBudgetLabel.append(checkBudget);
  checkBudgetLabel.hidden = !host.probe;
  const checkHint = document.createElement('p');
  checkHint.textContent =
    'Maximum wait for each channel. Scan checks every collected channel; Cancel keeps your saved channels. A response check does not confirm decoded playback.';
  checkHint.hidden = !host.probe;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  const sourceResults = document.createElement('ul');
  sourceResults.setAttribute('aria-label', 'Source results');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Channel, category or source';
  search.setAttribute('aria-label', 'Search scan results');
  const results = document.createElement('ul');
  results.className = 'scan-candidates';
  results.setAttribute('aria-label', 'Candidate channels');
  const count = document.createElement('p');
  let closed = false;
  let disposed = false;
  let busy = false;
  let saving = false;
  let scanPhase: SourceScanSnapshot['phase'] = 'idle';
  // The Slow list check, the full time limit for streams the triage left.
  let slowPass = false;
  let scanKind: AutomaticScanProgress['scanKind'];
  let scanTotal = 0,
    scanChecked = 0,
    scanResponded = 0,
    scanPublished = 0;
  let pendingPublications = 0;
  let windowRetryLimit: 64 | 256 = 256;
  let lastFailure: ScanFailure = 'none';
  let lastFailureCode: string | undefined;
  let preparationFailure: ScanPreparationFailureCode | undefined;
  let notifiedGeneration = 0;
  const recordFailure = (failure: unknown, publication = false) => {
    if (closed) return;
    const code = failure instanceof Error ? failure.message : failure;
    if (isScanPreparationFailureCode(code)) preparationFailure = code;
    const category = classifyScanFailure(failure, publication);
    if ((category !== 'other' && category !== 'canceled') || lastFailure === 'none') {
      lastFailure = category;
      lastFailureCode = scanFailureCode(failure);
    }
    scanPhase = lastFailure === 'canceled' ? 'paused' : 'failed';
  };
  const publish = async (...args: Parameters<SourceScanHost['commit']>) => {
    pendingPublications++;
    try {
      return await host.commit(...args);
    } catch (failure) {
      recordFailure(failure, true);
      throw failure;
    } finally {
      pendingPublications--;
    }
  };
  let automaticMode = false;
  let automaticPresentation: 'inline' | 'dialog' = 'dialog';
  let activeAutomaticQuery = '';
  let savedSummary: AutomaticScanProgress['savedSummary'];
  let summaryCheckpointRevision: string | undefined;
  let resumeRefusal: ScanResumeRefusal | undefined;
  let continueWork: Promise<void> | null = null;
  let scopeRefusal: 'query-changed' | null = null;
  function showAutomatic(): void {
    if (automaticPresentation === 'inline') {
      if (dialog.open) dialog.close();
    } else if (!dialog.open) dialog.showModal();
  }
  function notifyProgress(): void {
    if (!automaticMode || closed) return;
    try {
      host.onProgress?.(
        Object.freeze({
          ...snapshot(),
          canContinue:
            resumeRefusal === undefined &&
            (savedSummary === 'unfinished' ||
              (checkpoint !== null && scanPhase !== 'completed') ||
              (boundedSaved !== null && !boundedSaved.completed)),
          query: activeAutomaticQuery,
          presentation: automaticPresentation,
          status: (status.textContent ?? '').slice(0, 512),
          error: (error.textContent ?? '').slice(0, 512),
          scopeRefusal,
          ...(savedSummary === undefined ? {} : { savedSummary }),
          ...(resumeRefusal === undefined ? {} : { resumeRefusal }),
          ...(slowPass ? { slowPass: true as const } : {}),
          ...(scanKind ? { scanKind } : {}),
        }),
      );
    } catch {
      /* Observational callbacks cannot change actual scan ownership. */
    }
  }
  function queryMatches(requested: string | undefined): boolean {
    // A cold-restored bounded job carries its own query before any review is loaded.
    const captured = checkpoint?.review.query ?? boundedSaved?.query ?? activeAutomaticQuery;
    if (
      requested === undefined ||
      requested.toLowerCase() === normalizedScanQuery(captured).toLowerCase()
    )
      return true;
    scopeRefusal = 'query-changed';
    error.textContent =
      'Scan query changed. Use Rescan to start a new query; saved channels were retained.';
    notifyProgress();
    return false;
  }

  let checkpoint: {
    review: ScanReview;
    expectedRevision: string;
    observations: Map<string, HealthObservation>;
    published: Set<string>;
    platform: string | null;
    profile: string | undefined;
    jobId: string;
    createdAtMs: number;
    budgetMs: HealthCheckBudgetMs;
  } | null = null;
  let checkpointRevision = '0';
  let boundedResume: BoundedSourceScanResume | null = null;
  let boundedCleanupRefusal: { service: BoundedSourceScanResume; error: unknown } | null = null;
  let boundedSaved: { jobId: string; query: string; completed: boolean } | null = null;
  let storedJobId: string | null = null;
  let checkpointAdmissionLoaded = false;
  let checkpointRestoreRefused = false;
  let durableCheckpointAvailable = true;
  let backgroundPaused = false;
  let suspension: Promise<void> | null = null;
  let stopWork: Promise<void> | null = null;
  let restoreSuspendedReview: (() => void) | null = null;
  let owner = 0;
  let controller: AbortController | null = null;
  let work: Promise<void> = Promise.resolve();
  let review: ScanReview | null = null;
  let pipelineReview: PipelineReview | null = null;
  const guideSuggestions = new Map<string, GuideEnrichment[]>();
  let capturedSources: readonly ScanSource[] = [];
  let draftSources: readonly ScanSource[] | undefined;
  let page = 0;
  let sourcePage = 0;
  let sourceLabels = new Map<string, string>();
  let showOptions = false;
  const selected = new Set<string>();
  const health = new Map<string, HealthObservation>();
  let healthScope: {
    platform: string;
    observerProfile: string;
    budgetMs: HealthCheckBudgetMs;
  } | null = null;
  let historyMode = false;
  let automaticChecksComplete = !host.probe;
  let fileReview = false;
  const showAllLabel = document.createElement('label');
  const showAll = document.createElement('input');
  showAll.type = 'checkbox';
  showAllLabel.append(showAll, document.createTextNode('Show all collected channels'));
  showAll.addEventListener('change', () => {
    page = 0;
    render();
  });
  let historyPage: SavedHealthPage | null = null;
  let historyOffset = 0;
  let loadedHistoryOffset = 0;
  let scanSearch = '';
  const savedChecks = button('Saved checks', () => {
    if (busy) return;
    if (!historyMode) {
      scanSearch = search.value;
      search.value = '';
    }
    historyMode = true;
    historyPage = null;
    historyOffset = 0;
    runHistory();
  });
  const returnReview = button('Return to scan review', () => {
    if (busy) return;
    historyMode = false;
    search.value = scanSearch;
    status.textContent = '';
    error.textContent = '';
    render();
  });
  const scan = button('Scan', () => {
    if (automaticMode) {
      rescanAutomatic();
      return;
    }
    runScan();
  });
  scan.setAttribute('aria-label', 'Scan configured sources');
  const cancel = button('Cancel operation', () => {
    if (automaticMode) {
      void stopAutomatic().catch(() => undefined);
      return;
    }
    backgroundPaused = false;
    if (!saving) controller?.abort();
    host.activity?.(false);
  });
  const save = button('Save selected channels', () => runSave());
  const close = button('Close scan review', () => {
    void closeDialog();
  });
  close.setAttribute('aria-label', 'Close scan review');
  close.textContent = 'Close';
  save.setAttribute('aria-label', 'Save selected channels');
  save.textContent = 'Save';
  const previous = button('Previous results', () => {
    if (historyMode) {
      historyOffset = Math.max(0, historyOffset - 50);
      runHistory();
      return;
    }
    page--;
    render();
  });
  previous.setAttribute('aria-label', 'Previous results');
  previous.textContent = '‹';
  const next = button('Next results', () => {
    if (historyMode) {
      historyOffset += 50;
      runHistory();
      return;
    }
    page++;
    render();
  });
  next.setAttribute('aria-label', 'Next results');
  next.textContent = '›';
  const choose = button('Select all matching results', () => {
    for (const candidate of matches()) selected.add(candidate.key);
    render();
  });
  const clear = button('Clear selection', () => {
    selected.clear();
    render();
  });
  const check = button('Check selected channels', () => runCheck());
  const suggest = button('Find guide suggestions for selected channels', () => runGuideReview());
  const editOptions = button('Scan/check options', () => {
    optionsPanel.open = true;
    render();
  });
  check.hidden = !host.probe;
  const actions = document.createElement('select');
  actions.setAttribute('aria-label', 'Scan review action');
  const actionButtons = new Map([
    ['choose', choose],
    ['clear', clear],
    ['cancel', cancel],
    ['close', close],
    ['previous', previous],
    ['next', next],
    ['rescan', scan],
    ['options', editOptions],
    ...(host.savedHealth
      ? [['history', savedChecks] as const, ['review', returnReview] as const]
      : []),
    ...(host.probe ? [['check', check] as const] : []),
    ...(host.guides && host.enrich ? [['guides', suggest] as const] : []),
  ]);
  for (const [value, control] of actionButtons) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = control.getAttribute('aria-label') ?? control.textContent;
    actions.append(option);
  }
  const runAction = button('Run action', () => actionButtons.get(actions.value)?.click());
  runAction.setAttribute('aria-label', 'Run action');
  runAction.textContent = 'Run';
  actions.addEventListener('change', () => render());
  const sourceDetails = document.createElement('details');
  const sourceSummary = document.createElement('summary');
  const sourcePrevious = button('Previous sources', () => {
    sourcePage--;
    render();
  });
  const sourceNext = button('Next sources', () => {
    sourcePage++;
    render();
  });
  sourceDetails.append(sourceSummary, sourceResults, sourcePrevious, sourceNext);
  const optionsPanel = document.createElement('details');
  const optionsSummary = document.createElement('summary');
  optionsSummary.textContent = 'Advanced';
  optionsPanel.className = 'scan-options';
  optionsPanel.addEventListener('toggle', () => render());
  optionsPanel.append(
    optionsSummary,
    queryLabel,
    checkBudgetLabel,
    checkHint,
    showAllLabel,
    sourceDetails,
    actions,
    runAction,
  );
  const inputs = document.createElement('div');
  inputs.className = 'scan-inputs';
  inputs.append(search, previous, next);
  const feedback = document.createElement('div');
  feedback.className = 'scan-feedback';
  feedback.append(status, error, count);
  const footer = document.createElement('div');
  footer.className = 'scan-footer';
  footer.append(scan, save);
  const header = document.createElement('header');
  header.className = 'scan-header';
  header.append(heading, cancel, close);
  const setup = document.createElement('section');
  setup.className = 'scan-setup';
  const introduction = document.createElement('p');
  introduction.className = 'scan-introduction';
  introduction.textContent =
    'Scan your sources to find channels that respond. Save the results when the scan finishes.';
  setup.append(introduction, optionsPanel);
  const body = document.createElement('section');
  body.className = 'scan-body';
  body.append(setup, inputs, results);
  dialog.append(header, feedback, body, footer);
  container.append(trigger);
  // A settings dialog may be closed while the review modal is open.
  // Mount outside hidden/inert settings ancestors so the review stays usable.
  container.ownerDocument.body.append(dialog);
  function matches(): ReviewCandidate[] {
    const token = search.value.trim().normalize('NFKC').toLowerCase();
    return (
      review?.candidates.filter(
        (candidate) =>
          (fileReview ||
            !host.probe ||
            showAll.checked ||
            ['Reachable', 'PlayedHere'].includes(health.get(candidate.key)?.verdict ?? '')) &&
          `${candidate.channel.name} ${candidate.channel.category}`
            .normalize('NFKC')
            .toLowerCase()
            .includes(token),
      ) ?? []
    );
  }
  function render(): void {
    const uiBusy = busy || stopWork !== null;
    if (closed) return;
    results.setAttribute('aria-label', historyMode ? 'Saved checks' : 'Candidate channels');
    search.setAttribute('aria-label', historyMode ? 'Search saved checks' : 'Search scan results');
    heading.textContent = uiBusy ? 'Scanning' : review ? 'Channels' : 'Scan channels';
    const initial = !uiBusy && !review && !historyMode;
    dialog.dataset.scanState = initial && !optionsPanel.open ? 'start' : 'results';
    introduction.hidden = !initial;
    count.hidden = !review && !historyMode;
    setup.hidden = false;
    inputs.hidden = review === null;
    results.hidden = review === null;
    save.hidden = review === null;
    scan.textContent = review ? 'Rescan' : 'Scan';
    previous.hidden = next.hidden = review === null;
    cancel.hidden = !uiBusy;
    if (historyMode) {
      heading.textContent = 'Saved checks';
      setup.hidden = false;
      inputs.hidden = false;
      results.hidden = false;
      save.hidden = true;
    }
    queryLabel.hidden = review !== null;
    const sources = review?.sources ?? [];
    sourcePage = Math.max(0, Math.min(sourcePage, Math.max(0, Math.ceil(sources.length / 50) - 1)));
    sourceSummary.textContent = `Source outcomes: ${sources.length}. Showing ${sources.length ? sourcePage * 50 + 1 : 0}–${Math.min((sourcePage + 1) * 50, sources.length)}.`;
    sourceResults.replaceChildren();
    for (const source of sources.slice(sourcePage * 50, sourcePage * 50 + 50)) {
      const item = document.createElement('li');
      item.textContent = `${sourceLabels.get(source.sourceId) ?? 'Source'}: ${source.status} · ${source.matched} matches${source.status === 'failed' ? ' · Previous channels retained.' : ''}`;
      if (source.warnings) {
        const messages = source.warningMessages ?? [];
        const shown =
          messages.length <= 4
            ? messages
            : [...messages.slice(0, 3), messages[messages.length - 1]!];
        item.textContent += ` · ${source.warnings} source warnings. ${shown.join(' ')}${messages.length > shown.length ? ` ${messages.length - shown.length} additional warnings.` : ''}`;
      }
      sourceResults.append(item);
    }
    sourcePrevious.disabled = uiBusy || sourcePage === 0;
    sourceNext.disabled = uiBusy || (sourcePage + 1) * 50 >= sources.length;
    const matched = matches();
    page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(matched.length / 50) - 1)));
    count.textContent = `${matched.length} ${host.probe && !fileReview && !showAll.checked ? 'responded' : 'matches'}. ${selected.size} selected. Showing ${matched.length ? page * 50 + 1 : 0}–${Math.min((page + 1) * 50, matched.length)}.`;
    results.replaceChildren();
    for (const candidate of historyMode ? [] : matched.slice(page * 50, page * 50 + 50)) {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(candidate.key);
      checkbox.hidden = !optionsPanel.open;
      checkbox.disabled = uiBusy;
      checkbox.setAttribute('aria-label', `Select ${candidate.channel.name}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(candidate.key);
        else selected.delete(candidate.key);
        render();
      });
      const observed = health.get(candidate.key);
      const verdict = observed?.verdict ?? 'NotChecked';
      const verdictLabels: Record<string, string> = {
        Reachable: 'Responded',
        PlayedHere: 'Played on this device',
        NotChecked: 'Not checked',
        TimedOut: 'Did not respond in time',
        AccessDenied: 'Access denied',
        UnsupportedHere: 'Unsupported on this device',
        TemporaryUnavailable: 'Temporarily unavailable',
        Canceled: 'Check canceled',
      };
      label.append(
        checkbox,
        document.createTextNode(
          `${candidate.channel.name} · ${candidate.channel.category} · ${sourceLabels.get(candidate.sourceId) ?? 'Source'} · ${verdictLabels[verdict] ?? 'Not checked'}`,
        ),
      );
      item.append(label);
      if (observed && optionsPanel.open) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Check details';
        const information = document.createElement('p');
        information.textContent = `${observed.platform} · ${new Date(observed.observedAt).toLocaleString()} · ${checkEvidence(observed.evidence)}`;
        details.append(summary, information);
        item.append(details);
      }
      const suggestions = guideSuggestions.get(candidate.key) ?? [];
      if (suggestions.length) {
        const note = document.createElement('p');
        const counts = new Map<string, number>();
        for (const value of suggestions)
          counts.set(value.status, (counts.get(value.status) ?? 0) + 1);
        note.textContent = `Guide matches: ${[...counts].map(([state, total]) => `${total} ${state}`).join(' · ')}. Review and confirm the regional channel in Guide; no mapping saved.`;
        item.append(note);
      }
      if (host.openGuide && optionsPanel.open) {
        const guide = button('Review guide mapping', () => host.openGuide!(candidate));
        guide.disabled = uiBusy;
        item.append(guide);
      }
      results.append(item);
    }
    previous.disabled = uiBusy || page === 0;
    next.disabled = uiBusy || (page + 1) * 50 >= matched.length;
    if (historyMode) {
      const total = historyPage?.total ?? 0;
      count.textContent = `${total} saved checks. Showing ${historyPage?.rows.length ? historyOffset + 1 : 0}–${historyOffset + (historyPage?.rows.length ?? 0)}.`;
      for (const row of uiBusy ? [] : (historyPage?.rows ?? [])) {
        const item = document.createElement('li');
        const timestamp = new Date(row.observedAt);
        const name = document.createElement('strong');
        name.textContent = row.name;
        const summary = document.createElement('p');
        const verdicts = {
          NotChecked: 'Not checked',
          Reachable: 'Stream responded',
          PlayedHere: 'Playback observed',
          TimedOut: 'Check timed out',
          AccessDenied: 'Access denied',
          UnsupportedHere: 'Unsupported on this device',
          TemporaryUnavailable: 'Temporarily unavailable',
          Canceled: 'Check canceled',
        };
        const freshness = {
          current: 'Recent check',
          stale: 'Older check',
          'different-platform': 'Checked on another platform',
          'different-profile': 'Different check settings',
        };
        summary.textContent = `${verdicts[row.verdict]} · ${freshness[row.freshness]}${row.origin === 'imported' ? ' · Imported historical check' : ''}`;
        const time = document.createElement('time');
        const validTime = !Number.isNaN(timestamp.getTime());
        if (validTime) {
          time.dateTime = timestamp.toISOString();
          time.textContent = new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(timestamp);
        } else time.textContent = 'Unknown check time';
        const platform = document.createElement('span');
        const platformNames: Record<string, string> = {
          windows: 'Windows',
          android: 'Android',
          browser: 'Browser',
          'browser-preview': 'Browser',
          'browser-local': 'Browser',
        };
        platform.textContent = ` · ${platformNames[row.platform.toLowerCase()] ?? 'Other platform'}`;
        const details = document.createElement('details');
        const toggle = document.createElement('summary');
        toggle.textContent = 'Check details';
        const metadata = document.createElement('dl');
        for (const [label, value] of [
          ['Category', row.category || 'Uncategorized'],
          ['Source', row.sourceName],
          [
            'Stream',
            row.checkedUrlOrdinal === 0
              ? 'Primary stream'
              : `Alternate stream ${row.checkedUrlOrdinal + 1}`,
          ],
          ['Check settings', row.observerProfile],
          ['Platform', row.platform],
          ['Origin', row.origin === 'imported' ? 'Imported historical check' : 'Local check'],
          ['Exact check time', validTime ? timestamp.toISOString() : 'Unknown'],
          ['Evidence', checkEvidence(row.evidence)],
        ]) {
          const term = document.createElement('dt');
          term.textContent = label;
          const valueNode = document.createElement('dd');
          valueNode.textContent = value;
          metadata.append(term, valueNode);
        }
        details.append(toggle, metadata);
        item.append(name, summary, time, platform, details);
        results.append(item);
      }
      previous.disabled = uiBusy || historyOffset === 0;
      next.disabled = uiBusy || historyOffset + 50 >= total;
    }
    scan.disabled = uiBusy || fileReview;
    query.disabled = uiBusy;
    checkBudget.disabled = uiBusy;
    search.disabled = uiBusy;
    choose.disabled = uiBusy || !matched.length;
    clear.disabled = uiBusy || !selected.size;
    save.disabled =
      uiBusy ||
      !selected.size ||
      review?.status !== 'completed' ||
      (pipelineReview !== null && !pipelineReview.publishable);
    if (host.probe && !automaticChecksComplete) save.disabled = true;
    check.disabled = uiBusy || fileReview || !selected.size;
    suggest.disabled = uiBusy || fileReview || !selected.size;
    savedChecks.disabled = uiBusy;
    returnReview.disabled = uiBusy || !historyMode;
    if (historyMode) {
      for (const control of [choose, clear, scan, editOptions, check]) control.disabled = true;
    }
    cancel.disabled = !uiBusy || saving;
    close.disabled = saving;
    showAll.disabled = uiBusy;
    actions.disabled = saving;
    for (const option of actions.options)
      option.disabled = actionButtons.get(option.value)?.disabled ?? false;
    runAction.disabled = saving || (actionButtons.get(actions.value)?.disabled ?? true);
    if (automaticMode) {
      dialog.dataset.scanState = 'start';
      body.hidden = true;
      footer.hidden = uiBusy || (!checkpoint && !boundedSaved && !checkpointRestoreRefused);
      setup.hidden = inputs.hidden = results.hidden = count.hidden = true;
      save.hidden = true;
      scan.hidden = uiBusy || (!checkpoint && !boundedSaved && !checkpointRestoreRefused);
      scan.textContent = 'Rescan';
      close.textContent = uiBusy ? 'Close' : 'Done';
    } else {
      body.hidden = footer.hidden = false;
      scan.hidden = false;
      close.textContent = 'Close';
    }
    notifyProgress();
  }
  function snapshot(): Readonly<SourceScanSnapshot> {
    return Object.freeze({
      schemaVersion: 1,
      phase: disposed ? 'disposed' : pendingPublications ? 'publishing' : scanPhase,
      total: scanTotal,
      checked: scanChecked,
      responded: scanResponded,
      published: scanPublished,
      lastFailure,
      ...(lastFailureCode === undefined ? {} : { lastFailureCode }),
      ...(preparationFailure === undefined ? {} : { preparationFailure }),
      generation: owner,
      busy: (busy || stopWork !== null) && !disposed,
      pendingPublications,
    });
  }
  function begin(
    admissionOnly = false,
    preserveCounts = false,
  ): { signal: AbortSignal; generation: number } {
    savedSummary = undefined;
    busy = true;
    scanPhase = 'collecting';
    lastFailure = 'none';
    lastFailureCode = undefined;
    preparationFailure = undefined;
    if (!preserveCounts) {
      scanTotal = review?.candidates.length ?? 0;
      scanChecked = checkpoint?.observations.size ?? 0;
      scanResponded = checkpoint
        ? [...checkpoint.observations.values()].filter((observation) =>
            ['Reachable', 'PlayedHere'].includes(observation.verdict),
          ).length
        : 0;
      scanPublished = checkpoint?.published.size ?? 0;
    }
    if (!admissionOnly && automaticMode && !historyMode) host.activity?.(true);
    controller = new AbortController();
    const generation = ++owner;
    error.textContent = '';
    actions.value = 'cancel';
    render();
    return { signal: controller.signal, generation };
  }
  function finish(generation: number, admissionOnly = false): void {
    if (generation !== owner || closed) return;
    if (scanPhase === 'collecting' || scanPhase === 'checking')
      scanPhase = controller?.signal.aborted ? 'paused' : 'completed';
    if (
      !admissionOnly &&
      scanPhase === 'paused' &&
      lastFailure === 'none' &&
      controller?.signal.aborted
    )
      lastFailure = 'canceled';
    busy = false;
    if (!admissionOnly && !stopWork) host.activity?.(false);
    saving = false;
    restoreSuspendedReview = null;
    controller = null;
    actions.value = historyMode ? 'review' : host.probe && selected.size ? 'check' : 'choose';
    render();
    if (scanPhase === 'failed' && notifiedGeneration !== generation) {
      notifiedGeneration = generation;
      try {
        host.onDiagnostic?.(snapshot());
      } catch {
        /* A diagnostic sink is observational and cannot fail the scan. */
      }
    }
  }
  function runHistory(): void {
    if (busy || stopWork || suspension || closed || !host.savedHealth) return;
    const budgetMs = Number(checkBudget.value) as HealthCheckBudgetMs;
    if (![20000, 45000, 60000].includes(budgetMs)) {
      error.textContent = 'Choose a supported channel check time.';
      return;
    }
    const task = begin();
    const requested = {
      offset: historyOffset,
      pageSize: 50 as const,
      query: search.value,
      ...(historyPage ? { revision: historyPage.revision } : {}),
      signal: task.signal,
      budgetMs,
    };
    status.textContent = 'Loading saved checks…';
    work = (async () => {
      try {
        const result = await host.savedHealth!(requested);
        if (closed || task.signal.aborted || task.generation !== owner) {
          if (task.signal.aborted) historyOffset = loadedHistoryOffset;
          return;
        }
        if (result.rows.length > 50 || result.total < result.rows.length || !result.revision)
          throw new Error('Invalid saved check page.');
        historyPage = result;
        loadedHistoryOffset = requested.offset;
        status.textContent =
          'Saved observations describe the recorded platform and time; reachability does not prove playback.';
      } catch (failure) {
        if (task.generation === owner) recordFailure(failure);
        if (task.signal.aborted) historyOffset = loadedHistoryOffset;
        if (!closed && !task.signal.aborted && task.generation === owner) {
          historyPage = null;
          historyOffset = 0;
          error.textContent =
            failure instanceof Error &&
            failure.message === 'Saved checks changed. Start from the first page.'
              ? failure.message
              : 'Saved checks could not load. Retry from the first page; your library is retained.';
          status.textContent = '';
        }
      } finally {
        finish(task.generation);
      }
    })();
  }
  function runScan(): void {
    if (busy || stopWork || suspension || closed) return;
    fileReview = false;
    const prior = {
      review,
      pipelineReview,
      capturedSources,
      sourceLabels,
      page,
      sourcePage,
      showOptions,
      selected: [...selected],
      health: [...health],
      healthScope,
      automaticChecksComplete,
    };
    restoreSuspendedReview = () => {
      review = prior.review;
      pipelineReview = prior.pipelineReview;
      capturedSources = prior.capturedSources;
      sourceLabels = prior.sourceLabels;
      page = prior.page;
      sourcePage = prior.sourcePage;
      showOptions = prior.showOptions;
      selected.clear();
      for (const key of prior.selected) selected.add(key);
      health.clear();
      for (const [key, value] of prior.health) health.set(key, value);
      healthScope = prior.healthScope;
      automaticChecksComplete = prior.automaticChecksComplete;
      indexSuggestions();
    };
    if (automaticMode) checkpoint = null;
    const task = begin();
    review = null;
    showOptions = false;
    pipelineReview = null;
    guideSuggestions.clear();
    selected.clear();
    health.clear();
    healthScope = null;
    sourceResults.replaceChildren();
    render();
    automaticChecksComplete = !host.probe;
    status.textContent = 'Finding channels in your saved sources…';
    notifyProgress();
    const capturedQuery = automaticMode ? activeAutomaticQuery : query.value;
    work = (async () => {
      try {
        if (automaticMode && !host.probe) throw new Error('Channel checks unavailable');
        const snapshot = host.capture(draftSources);
        capturedSources = structuredClone(snapshot.sources);
        const labels = new Map(
          snapshot.sources.map(({ source }) => [source.id, source.name.slice(0, 160)]),
        );
        sourceLabels = labels;
        sourcePage = 0;
        const pipelineResult = null;
        const collected = await (async () => {
          try {
            return await scanConfiguredSources(
              snapshot.sources,
              (source, signal) => host.collect(source, signal),
              {
                sessionRevision: snapshot.revision,
                query: capturedQuery,
                signal: task.signal,
                ...(host.aliases ? { aliases: host.aliases } : {}),
                progress: (event) => {
                  if (!closed && !task.signal.aborted)
                    status.textContent = `Finding channels · ${event.settled} of ${event.total} sources checked`;
                },
              },
            );
          } finally {
            host.onCollectionSettled?.();
          }
        })();
        if (closed || task.generation !== owner) return;
        const prioritized = host.prioritize ? host.prioritize(collected) : collected;
        // Collection already owns its channel copies; detach small warning arrays too.
        const result = automaticMode
          ? freezeCapture({
              ...prioritized,
              sources: prioritized.sources.map((source) => ({
                ...source,
                ...(source.warningMessages ? { warningMessages: [...source.warningMessages] } : {}),
              })),
            })
          : prioritized;
        if (automaticMode && result.status === 'completed')
          checkpoint = {
            review: result,
            expectedRevision: result.sessionRevision,
            observations: new Map(),
            published: new Set(),
            platform: null,
            profile: undefined,
            jobId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join(''),
            createdAtMs: host.now?.() ?? Date.now(),
            budgetMs: Number(checkBudget.value) as HealthCheckBudgetMs,
          };
        review = result;
        scanTotal = result.candidates.length;
        pipelineReview = pipelineResult;
        indexSuggestions();
        if (result.status === 'completed' && host.probe) {
          await checkCaptured(result, task, true);
          return;
        }
        status.textContent =
          result.status === 'canceled'
            ? 'Scan canceled. Existing channels retained.'
            : `${result.counts.matched} candidates ready for review. ${result.counts.failedSources} sources failed; previous channels retained.`;
      } catch (failure) {
        recordFailure(failure);
        if (!closed) {
          status.textContent = 'Review retained.';
          error.textContent =
            lastFailure === 'publish-failed'
              ? 'Channels could not be saved. Saved channels are safe; Finish scan retries from the last saved progress.'
              : task.signal.aborted && lastFailure === 'canceled'
                ? 'Scan canceled. Existing channels retained.'
                : automaticMode && lastFailure === 'configuration-changed'
                  ? 'Scan paused because your sources, location or check settings changed. Select Rescan to check the current setup. Saved channels retained.'
                  : automaticMode && lastFailure === 'catalog-cas'
                    ? 'Saved channels changed while scanning. Select Rescan to continue safely. Saved channels retained.'
                    : 'Scan could not finish. Check configured source availability and supported limits; existing channels retained.';
        }
      } finally {
        finish(task.generation);
      }
    })();
  }
  function runSave(): Promise<void> {
    if (
      busy ||
      stopWork ||
      suspension ||
      !review ||
      closed ||
      (host.probe && !automaticChecksComplete)
    )
      return Promise.resolve();
    const captured = review;
    saving = true;
    const task = begin();
    status.textContent = 'Saving reviewed selection…';
    work = (async () => {
      try {
        const revision = host.revision();
        const staged = pipelineReview
          ? stagePipelineSelection(pipelineReview, [...selected], revision)
          : stageScanSelection(captured, [...selected], revision);
        task.signal.throwIfAborted();
        const checkedCandidates = captured.candidates.filter(
          (candidate) => selected.has(candidate.key) && health.has(candidate.key),
        );
        if (
          healthScope &&
          (host.platform?.() !== healthScope.platform ||
            host.observerProfile?.(healthScope.budgetMs) !== healthScope.observerProfile)
        )
          throw new Error('The health observer changed. Check the selection again.');
        const healthContext = healthScope
          ? structuredClone({
              ...healthScope,
              candidates: checkedCandidates,
              observations: checkedCandidates.map((candidate) => health.get(candidate.key)!),
            })
          : undefined;
        const receipt = await publish(staged, revision, task.signal, healthContext);
        if (receipt.committed !== true || !receipt.revision.trim())
          throw new Error('Missing durable receipt.');
        scanPublished += selected.size;
        if (!closed) {
          status.textContent = automaticMode
            ? `${selected.size} ${selected.size === 1 ? 'channel' : 'channels'} saved.`
            : 'Selected channels saved.';
          selected.clear();
        }
      } catch (failure) {
        recordFailure(failure);
        if (!closed) {
          status.textContent = 'Review retained.';
          error.textContent = task.signal.aborted
            ? 'Save canceled. Review remains available.'
            : 'Selection was not saved. The catalog may have changed; scan again or retry. Review remains available.';
        }
      } finally {
        finish(task.generation);
      }
    })();
    return work;
  }
  async function prepareCheckpointMutation(
    signal: AbortSignal,
    publishedKeys?: string[],
    publicationLimit: 64 | 256 = 64,
    publicationKeys?: readonly string[],
  ): Promise<ScanCheckpointMutation | null> {
    if (!host.checkpoint || !checkpoint || !durableCheckpointAvailable) return null;
    if (!checkpoint.platform || !checkpoint.profile) return null;
    const snapshot = {
      jobId: checkpoint.jobId,
      createdAtMs: checkpoint.createdAtMs,
      review: checkpoint.review,
      capturedSources: structuredClone(capturedSources),
      budgetMs: checkpoint.budgetMs,
      platform: checkpoint.platform,
      observerProfile: checkpoint.profile,
      observations: [...checkpoint.observations.values()],
      publishedKeys: publishedKeys ?? [...checkpoint.published],
      catalogRevision: checkpoint.expectedRevision,
    };
    const mutation =
      host.checkpoint.prepareMutation && host.checkpoint.saveMutation
        ? await host.checkpoint.prepareMutation(
            snapshot,
            signal,
            checkpointRevision,
            publicationLimit,
            publicationKeys,
          )
        : await host.checkpoint
            .prepare(snapshot, signal)
            .then((text) => (text === null ? null : { kind: 'save' as const, checkpoint: text }));
    signal.throwIfAborted();
    if (mutation === null) {
      durableCheckpointAvailable = false;
      error.textContent = 'This scan can resume while the app stays open; restart requires Rescan.';
    }
    return mutation;
  }
  async function persistCheckpoint(actualSignal?: AbortSignal): Promise<void> {
    // Native closing has frozen new admission. Previously acknowledged progress
    // remains authoritative; never-acknowledged checks can be repeated on Continue.
    if (closed || !host.checkpoint || !checkpoint || !durableCheckpointAvailable) return;
    try {
      const signal = actualSignal ?? new AbortController().signal;
      let mutation: ScanCheckpointMutation | null;
      try {
        mutation = await prepareCheckpointMutation(signal);
      } catch (failure) {
        // Close freezes new native admission. This preparation has actually
        // settled; retain the last ACK rather than launching any new write.
        // Dispatched saves and earlier work joins remain outside this handler.
        if (closed) return;
        throw failure;
      }
      if (closed || mutation === null) return;
      const receipt = host.checkpoint.saveMutation
        ? await host.checkpoint.saveMutation(
            mutation,
            checkpoint.expectedRevision,
            checkpointRevision,
            signal,
          )
        : await host.checkpoint.save(
            mutation.kind === 'save'
              ? mutation.checkpoint
              : (() => {
                  throw new Error('Checkpoint mutation is unsupported.');
                })(),
            checkpoint.expectedRevision,
            checkpointRevision,
            signal,
          );
      if (receipt.committed !== true || !receipt.checkpointRevision)
        throw new Error('Missing checkpoint receipt');
      checkpointRevision = receipt.checkpointRevision;
      host.checkpoint.acknowledgeMutation?.(mutation, receipt.checkpointRevision);
      storedJobId = checkpoint.jobId;
    } catch (failure) {
      recordFailure(failure);
      const message = 'Saved scan could not be updated. Existing channels retained.';
      error.textContent = message;
      throw new Error(message, { cause: failure });
    }
  }
  async function checkCaptured(
    captured: ScanReview,
    task: { signal: AbortSignal; generation: number },
    preselect: boolean,
  ): Promise<void> {
    scanPhase = 'checking';
    scanTotal = captured.candidates.length;
    if (automaticMode && captured.candidates.length === 0) {
      automaticChecksComplete = true;
      automaticCompletion(captured, 0);
      return;
    }
    const budgetMs =
      automaticMode && checkpoint
        ? checkpoint.budgetMs
        : (Number(checkBudget.value) as HealthCheckBudgetMs);
    if (![20000, 45000, 60000].includes(budgetMs)) throw new Error('Channel check time invalid');
    const platform = host.platform?.() ?? 'browser-local';
    const observerProfile = host.observerProfile?.(budgetMs);
    if (
      !platform ||
      platform === 'native-unavailable' ||
      (observerProfile !== undefined && (!observerProfile.trim() || observerProfile.length > 256))
    )
      throw new Error('Channel check platform unavailable');
    if (observerProfile) healthScope = { platform, observerProfile, budgetMs };
    const retained = automaticMode ? checkpoint : null;
    if (
      retained &&
      (retained.review.sessionRevision !== captured.sessionRevision ||
        host.revision() !== retained.expectedRevision ||
        (retained.platform !== null &&
          (retained.platform !== platform || retained.profile !== observerProfile)))
    )
      throw new Error('Scan checkpoint changed');
    if (retained) {
      retained.platform = platform;
      retained.profile = observerProfile;
      if (storedJobId !== retained.jobId) {
        // The initial admitted collection must survive a crash before the first publication.
        await persistCheckpoint(task.signal);
        task.signal.throwIfAborted();
        if (closed || task.generation !== owner || checkpoint !== retained)
          throw new Error('Scan changed');
      }
    }
    let expectedRevision = retained?.expectedRevision ?? captured.sessionRevision;
    let published = retained?.published.size ?? 0;
    // Capture variant ambiguity once for the full review, not just each publication batch.
    const reconciliationScopes = scanReconciliationScopes(captured);
    let episode: SourceScanSelectionEpisode | null = null;
    try {
      if (automaticMode && host.beginSelectionEpisode) {
        episode = await host.beginSelectionEpisode(
          {
            generation: task.generation,
            revision: expectedRevision,
            capturedSources,
            reconciliationScopes,
          },
          task.signal,
        );
        task.signal.throwIfAborted();
        if (closed || task.generation !== owner || host.revision() !== expectedRevision)
          throw new Error('Scan changed');
        if (episode && (!episode.episodeId.trim() || episode.episodeId.length > 256))
          throw new Error('Selection episode unavailable');
      }

      type Entry = { candidate: ReviewCandidate; observation: HealthObservation };
      const useWindow = !!host.commitWindow && episode?.supportsWindow === true;
      const flush = async (batch: readonly Entry[]): Promise<void> => {
        task.signal.throwIfAborted();
        if (closed || task.generation !== owner || host.revision() !== expectedRevision)
          throw new Error('Scan changed');
        if (
          healthScope &&
          (host.platform?.() !== healthScope.platform ||
            host.observerProfile?.(healthScope.budgetMs) !== healthScope.observerProfile)
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
            ...(healthScope
              ? {
                  health: structuredClone({
                    ...healthScope,
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
                expectedCheckpointRevision: checkpointRevision,
              };
        let receipt: { committed: true; revision: string; checkpointRevision?: string };
        if (useWindow) {
          pendingPublications++;
          try {
            receipt = await host.commitWindow!(
              chunks,
              expectedRevision,
              task.signal,
              checkpointContext,
              episode?.episodeId,
            );
          } catch (failure) {
            if (failure instanceof SourceScanWindowSizeError) windowRetryLimit = 64;
            recordFailure(failure, true);
            throw failure;
          } finally {
            pendingPublications--;
          }
        } else {
          receipt = await publish(
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
          checkpointRevision = receipt.checkpointRevision;
          host.checkpoint?.acknowledgeMutation?.(
            checkpointContext.mutation,
            receipt.checkpointRevision,
          );
          storedJobId = retained!.jobId;
        }
        expectedRevision = receipt.revision;
        if (retained) {
          retained.expectedRevision = expectedRevision;
          for (const entry of batch) retained.published.add(entry.candidate.key);
        }
        scanPublished += batch.length;
        if (host.revision() !== expectedRevision) throw new Error('Scan changed');
        published += batch.length;
        notifyProgress();
      };
      const publisher = automaticMode
        ? createScanPublisher<Entry>({
            signal: task.signal,
            publish: flush,
            ...(useWindow
              ? {
                  capacity: 256,
                  initialBatchSize: 64,
                  maxBatchSize: windowRetryLimit,
                  // Reserve repeated candidate/health DTOs and per-entry wire framing.
                  sizeOf: (entry: Entry) =>
                    new TextEncoder().encode(JSON.stringify(entry)).byteLength * 4 + 4096,
                  maxBytes: 20 * 1024 * 1024,
                }
              : {}),
            failed: (failure) => {
              recordFailure(failure, true);
              controller?.abort();
            },
          })
        : null;
      const onObservation = publisher
        ? async (candidate: ReviewCandidate, observation: HealthObservation): Promise<void> => {
            task.signal.throwIfAborted();
            if (closed || task.generation !== owner) throw new Error('Scan changed');
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
        scanChecked = alreadyChecked;
        scanResponded = alreadyResponded;
        if (retained) {
          // The filtered array/wrapper are new; their children belong to the frozen capture.
          Object.freeze(remaining.candidates);
          Object.freeze(remaining);
        }
        const checker = retained ? checkOwnedScanCandidates : checkScanCandidates;
        checked = await checker(remaining, {
          probe: (candidate, signal, budget) => host.probe!(candidate, signal, budget),
          platform,
          budgetMs,
          maxConcurrency: automaticMode ? 16 : 4,
          sourcePolicies: capturedSources.map(({ source, fingerprint }) => ({
            sourceId: source.id,
            fingerprint,
            allowHttp: source.allowHttp === true,
          })),
          onObservation,
          signal: task.signal,
          now: host.now,
          progress: (event) => {
            if (closed || task.generation !== owner || task.signal.aborted) return;
            if (event.observation)
              health.set(
                event.observation.channelId,
                retained?.observations.get(event.observation.channelId) ?? event.observation,
              );
            scanChecked = alreadyChecked + event.done;
            scanResponded = alreadyResponded + event.responded;
            status.textContent = `Checking ${alreadyChecked + event.done} of ${captured.candidates.length} channels \u00b7 ${alreadyResponded + event.responded} responded`;
            notifyProgress();
          },
        });
      } catch (failure) {
        // A scan-wide check failure stops queued publication; active native work is still joined below.
        controller?.abort();
        throw failure;
      } finally {
        await publisher?.drain();
      }
      task.signal.throwIfAborted();
      if (closed || task.generation !== owner || host.revision() !== expectedRevision)
        throw new Error('Scan changed');
      for (const observed of retained?.observations.values() ?? checked.observations)
        health.set(observed.channelId, observed);
      if (preselect) {
        selected.clear();
        for (const observed of retained?.observations.values() ?? checked.observations)
          if (['Reachable', 'PlayedHere'].includes(observed.verdict))
            selected.add(observed.channelId);
      }
      automaticChecksComplete = true;
      if (automaticMode) {
        automaticCompletion(captured, published);
        return;
      }
      status.textContent = `${checked.eligibleKeys.length} channels responded. ${captured.candidates.length - checked.eligibleKeys.length} could not be verified. Save to add the responding channels.`;
    } finally {
      await episode?.dispose();
    }
  }
  function automaticCompletion(captured: ScanReview, published: number): void {
    const failed = captured.counts.failedSources;
    const unfinished =
      checkpoint !== null && checkpoint.observations.size < captured.candidates.length;
    if (unfinished) {
      automaticChecksComplete = false;
      scanPhase = 'paused';
      scanChecked = checkpoint!.observations.size;
      scanResponded = 0;
      for (const observation of checkpoint!.observations.values())
        if (observation.verdict === 'Reachable' || observation.verdict === 'PlayedHere')
          scanResponded++;
      status.textContent = `Scan paused. ${scanPublished} channels saved. Finish scan to retry unfinished checks.`;
      error.textContent =
        'Some checks were not confirmed. Finish scan to retry unfinished channels. Your saved channels are retained.';
    } else
      status.textContent = !captured.candidates.length
        ? 'No channels were collected. Nothing was added.'
        : published === 0
          ? 'No channels responded. Nothing was added.'
          : `${published} ${published === 1 ? 'channel' : 'channels'} saved.`;
    if (failed) {
      const message = `${captured.candidates.length} channels collected. ${failed} of ${captured.sources.length} sources could not be read. Your saved channels were retained. Select Rescan to retry.`;
      error.textContent = [message, error.textContent].filter(Boolean).join(' ');
    } else if (!captured.candidates.length) {
      error.textContent =
        'No supported channels were found. Your saved channels were retained. Select Rescan to retry.';
    }
  }
  function runCheck(): void {
    if (busy || stopWork || suspension || !review || !host.probe || closed) return;
    const captured = {
      ...review,
      candidates: review.candidates.filter((candidate) => selected.has(candidate.key)),
    };
    const task = begin();
    automaticChecksComplete = false;
    work = (async () => {
      try {
        await checkCaptured(captured, task, false);
      } catch (failure) {
        recordFailure(failure);
        if (!closed)
          error.textContent = task.signal.aborted
            ? 'Checks canceled. Completed observations retained; rescan before saving.'
            : 'Checks could not finish. Existing channels retained.';
      } finally {
        finish(task.generation);
      }
    })();
  }
  function runGuideReview(): void {
    if (busy || closed || !review || !host.guides || !host.enrich) return;
    const candidates = review.candidates.filter((candidate) => selected.has(candidate.key));
    if (candidates.length > 1000) {
      error.textContent =
        'Choose up to 1,000 channels for this optional guide-suggestion action. The full channel scan is retained.';
      return;
    }
    const captured = review;
    const task = begin();
    status.textContent = 'Optional guide suggestions: this action has a two-minute budget.';
    work = (async () => {
      try {
        const checked = await runPipeline(
          capturedSources,
          candidates.map((candidate) => candidate.key),
          task.signal,
          captured.query,
          captured.sessionRevision,
          candidates,
          Number(checkBudget.value) as HealthCheckBudgetMs,
        );
        if (closed || task.generation !== owner) return;
        pipelineReview = checked;
        if (checked.publishable) {
          review = checked.scan;
          for (const observation of checked.observations)
            health.set(observation.channelId, observation);
        }
        indexSuggestions();
        status.textContent = checked.publishable
          ? 'Guide suggestions ready. Confirm them in Guide before use.'
          : 'Guide suggestions incomplete. Existing channels retained.';
      } catch (failure) {
        recordFailure(failure);
        if (!closed)
          error.textContent = 'Guide suggestions could not finish. Existing channels retained.';
      } finally {
        finish(task.generation);
      }
    })();
  }
  function indexSuggestions(): void {
    guideSuggestions.clear();
    for (const suggestion of pipelineReview?.enrichment ?? []) {
      const values = guideSuggestions.get(suggestion.candidateKey) ?? [];
      values.push(suggestion);
      guideSuggestions.set(suggestion.candidateKey, values);
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
    const guides = await host.guides!(signal);
    signal.throwIfAborted();
    if (host.revision() !== expectedRevision) throw new Error('Collection snapshot is obsolete.');
    const platform = host.platform?.() ?? 'This platform';
    const pipeline = createCollectionPipeline({
      collect: (source, ownedSignal) => host.collect(source, ownedSignal),
      probe: async (candidate, ownedSignal) => {
        if (!host.probe)
          return {
            candidateKey: candidate.key,
            sourceId: candidate.sourceId,
            sourceFingerprint: candidate.sourceFingerprint,
            platform,
            evidence: { kind: 'not-checked' },
          };
        const observed = await host.probe(candidate, ownedSignal, budgetMs);
        return {
          candidateKey: observed.channelId,
          sourceId: observed.sourceId,
          sourceFingerprint: observed.fingerprint,
          platform: observed.platform,
          evidence: observed.evidence,
        };
      },
      enrich: (candidate, registered, ownedSignal) =>
        host.enrich!(candidate, registered, ownedSignal),
      revision: () => host.revision(),
      now: () => host.now?.() ?? Date.now(),
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
        if (!closed && !signal.aborted)
          status.textContent = `${event.phase}: ${event.completed}/${event.total} settled`;
      },
    });
  }
  async function closeDialog(): Promise<void> {
    if (automaticMode && (busy || stopWork)) {
      dialog.close();
      return;
    }
    if (saving) return;
    controller?.abort();
    await work;
    if (!closed) dialog.close();
  }
  function open(
    sources?: readonly ScanSource[],
    presentation: 'inline' | 'dialog' = 'dialog',
  ): void {
    if (closed || busy || stopWork || suspension) return;
    savedSummary = undefined;
    automaticMode = false;
    if (sources) fileReview = false;
    draftSources = sources?.map((entry) => ({ ...entry, source: { ...entry.source } }));
    if (sources) {
      historyMode = false;
      review = null;
      pipelineReview = null;
      guideSuggestions.clear();
      selected.clear();
      health.clear();
      healthScope = null;
      sourceResults.replaceChildren();
    }
    automaticPresentation = presentation;
    showAutomatic();
    render();
  }
  search.addEventListener('input', () => {
    if (historyMode) {
      historyOffset = 0;
      historyPage = null;
      runHistory();
      return;
    }
    page = 0;
    render();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    void closeDialog();
  });
  render();
  function rescanAutomatic(
    sources?: readonly ScanSource[],
    options: AutomaticScanOptions = {},
  ): void {
    const nextQuery =
      options.query === undefined
        ? (checkpoint?.review.query ?? activeAutomaticQuery)
        : normalizedScanQuery(options.query);
    if (options.presentation !== undefined && !['inline', 'dialog'].includes(options.presentation))
      throw new Error('Scan presentation is invalid.');
    if (closed || busy || stopWork || suspension) return;
    if (host.indexedFreshAvailable?.()) {
      // Explicit full recheck stages new work before native activation replaces
      // the exact saved owner under CAS. Ordinary Refresh continues that owner.
      startAutomatic(sources, {
        query: nextQuery,
        presentation: options.presentation,
        intent: 'full-recheck',
      });
      return;
    }
    automaticPresentation = options.presentation ?? automaticPresentation;
    backgroundPaused = false;
    if (checkpointRestoreRefused && !storedJobId && resumeRefusal !== 'missing') {
      automaticMode = true;
      showAutomatic();
      error.textContent = 'Saved scan ownership could not be verified. Existing channels retained.';
      render();
      return;
    }
    if (!host.checkpoint || !storedJobId) {
      resumeRefusal = undefined;
      summaryCheckpointRevision = undefined;
      checkpoint = null;
      boundedSaved = null;
      checkpointAdmissionLoaded = true;
      checkpointRestoreRefused = false;
      durableCheckpointAvailable = true;
      activeAutomaticQuery = nextQuery;
      startAutomatic(sources, { query: nextQuery, presentation: automaticPresentation });
      return;
    }
    automaticMode = true;
    showAutomatic();
    const task = begin();
    work = (async () => {
      let discarded = false;
      try {
        const receipt = await host.checkpoint!.discard(
          storedJobId!,
          host.revision(),
          checkpointRevision,
          task.signal,
        );
        if (receipt.committed !== true || !receipt.checkpointRevision)
          throw new Error('Missing checkpoint receipt');
        checkpointRevision = receipt.checkpointRevision;
        storedJobId = null;
        resumeRefusal = undefined;
        summaryCheckpointRevision = undefined;
        checkpoint = null;
        boundedSaved = null;
        checkpointAdmissionLoaded = true;
        checkpointRestoreRefused = false;
        durableCheckpointAvailable = true;
        discarded = true;
      } catch (failure) {
        recordFailure(failure);
        error.textContent = 'Saved scan could not be cleared. Existing channels retained.';
      } finally {
        finish(task.generation);
      }
      if (discarded && !closed && !task.signal.aborted) {
        activeAutomaticQuery = nextQuery;
        startAutomatic(sources, { query: nextQuery, presentation: automaticPresentation });
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
    if (checkpoint && !continuing) return false;
    if (!host.checkpoint) {
      if (continuing && !checkpoint) throw new ContinueRefusal('missing');
      return checkpoint ? false : true;
    }
    if (checkpointAdmissionLoaded && !continuing) return true;
    // Only an actual null preparation can authorize this same-session RAM path.
    // A size refusal or a disappeared previously ACKed checkpoint cannot do so.
    const ownedRamOnly =
      !!continuing && !!checkpoint && !durableCheckpointAvailable && storedJobId === null;
    const saved = await host.checkpoint!.load(task.signal);
    task.signal.throwIfAborted();
    if (closed || task.generation !== owner)
      throw new DOMException('Scan entry canceled.', 'AbortError');
    checkpointRevision = saved.checkpointRevision;
    storedJobId = saved.jobId;
    if (continuing) {
      if (saved.checkpointStatus === 'absent') {
        if (
          ownedRamOnly &&
          checkpoint &&
          saved.jobId === null &&
          saved.checkpointRevision === continuing.revision &&
          checkpoint.expectedRevision === host.revision() &&
          checkpoint.platform === host.platform?.() &&
          checkpoint.profile === host.observerProfile?.(checkpoint.budgetMs)
        ) {
          checkpointAdmissionLoaded = true;
          checkpointRestoreRefused = false;
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
    checkpointAdmissionLoaded = true;
    if (saved.checkpointStatus === 'absent') {
      return true;
    }
    checkpointRestoreRefused = true;
    const parsed = saved.parsed;
    if (
      saved.checkpointStatus !== 'valid' ||
      !parsed ||
      (host.now?.() ?? Date.now()) < parsed.createdAtMs ||
      (host.now?.() ?? Date.now()) - parsed.createdAtMs >= 86400000 ||
      host.platform?.() !== parsed.platform ||
      host.observerProfile?.(parsed.budgetMs) !== parsed.observerProfile
    )
      throw new Error('Saved scan unavailable');
    let trustedRam: ReadonlyMap<string, HealthObservation> | undefined;
    if (continuing && checkpoint) {
      const retained = checkpoint;
      const assertCurrent = () => {
        task.signal.throwIfAborted();
        if (closed || task.generation !== owner || checkpoint !== retained)
          throw new DOMException('Scan entry canceled.', 'AbortError');
        if (
          retained.expectedRevision !== host.revision() ||
          retained.platform !== host.platform?.() ||
          retained.profile !== host.observerProfile?.(retained.budgetMs)
        )
          throw new ContinueRefusal('changed');
      };
      const sourceBudget = { remaining: 100000 };
      const admittedPublished = new Set(parsed.publishedKeys);
      if (
        checkpoint.expectedRevision !== host.revision() ||
        checkpoint.jobId !== parsed.jobId ||
        checkpoint.createdAtMs !== parsed.createdAtMs ||
        checkpoint.platform !== parsed.platform ||
        checkpoint.profile !== parsed.observerProfile ||
        checkpoint.budgetMs !== parsed.budgetMs ||
        !(await sameImmutableScanReview(
          checkpoint.review,
          parsed.review,
          task.signal,
          assertCurrent,
        )) ||
        capturedSources.length !== parsed.sourceDefinitions.length ||
        capturedSources.some(
          (entry, index) =>
            !sameCapturedSource(
              entry.source,
              parsed.sourceDefinitions[index]!.source,
              sourceBudget,
            ),
        ) ||
        [...checkpoint.published].some((key) => !admittedPublished.has(key))
      )
        throw new ContinueRefusal('changed');
      assertCurrent();
      trustedRam = checkpoint.observations;
    }
    checkpointRestoreRefused = false;
    capturedSources = parsed.sourceDefinitions.map((definition) => ({
      source: definition.source,
      fingerprint: parsed.review.sources.find((source) => source.sourceId === definition.source.id)!
        .fingerprint,
    }));
    checkpoint = {
      review: freezeCapture(structuredClone(parsed.review)),
      expectedRevision: host.revision(),
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
        if (!checkpoint.observations.has(key)) checkpoint.observations.set(key, observation);
    review = checkpoint.review;
    activeAutomaticQuery = checkpoint.review.query;
    sourceLabels = new Map(capturedSources.map((entry) => [entry.source.id, entry.source.name]));
    checkBudget.value = String(parsed.budgetMs);
    scanTotal = checkpoint.review.candidates.length;
    scanChecked = checkpoint.observations.size;
    scanResponded = [...checkpoint.observations.values()].filter((observation) =>
      ['Reachable', 'PlayedHere'].includes(observation.verdict),
    ).length;
    scanPublished = checkpoint.published.size;
    return false;
  }
  function automaticEntryState(ignoreBusy = false): AutomaticScanEntry {
    if (closed || checkpointRestoreRefused) return 'unavailable';
    if ((busy || stopWork) && !ignoreBusy) return 'running';
    if (boundedSaved) return boundedSaved.completed ? 'completed' : 'unfinished';
    if (!checkpoint) return 'fresh';
    if (host.revision() !== checkpoint.expectedRevision) return 'unavailable';
    const pending =
      checkpoint.observations.size < checkpoint.review.candidates.length ||
      [...checkpoint.observations].some(
        ([key, observation]) =>
          ['Reachable', 'PlayedHere'].includes(observation.verdict) &&
          !checkpoint!.published.has(key),
      );
    return pending ? 'unfinished' : 'completed';
  }
  let entryWork: Promise<AutomaticScanEntry> | null = null;
  function prepareAutomaticEntry(): Promise<AutomaticScanEntry> {
    if (stopWork) return stopWork.then(() => automaticEntryState());
    if (entryWork) return entryWork;
    if (
      closed ||
      busy ||
      stopWork ||
      suspension ||
      checkpoint ||
      boundedSaved ||
      checkpointAdmissionLoaded ||
      !host.checkpoint
    )
      return Promise.resolve(automaticEntryState());
    const task = begin(true);
    const pending = (async () => {
      try {
        await loadAutomaticCheckpoint(task);
      } catch {
        if (!task.signal.aborted && !closed) checkpointRestoreRefused = true;
      } finally {
        // Admission is read-only: completing this owner is not completing a channel scan.
        scanPhase = checkpoint
          ? automaticEntryState(true) === 'completed'
            ? 'completed'
            : 'paused'
          : 'idle';
        finish(task.generation, true);
      }
      return automaticEntryState();
    })().finally(() => {
      if (entryWork === pending) entryWork = null;
    });
    entryWork = pending;
    work = pending.then(() => undefined);
    return pending;
  }
  function startAutomatic(
    sources?: readonly ScanSource[],
    options: AutomaticScanOptions = {},
  ): void {
    const indexedFresh = options.intent !== 'continue' && !!host.indexedFreshAvailable?.();
    const continuing = options.intent === 'continue';
    if (
      options.intent !== undefined &&
      !['start', 'continue', 'full-recheck', 'slow'].includes(options.intent)
    )
      throw new Error('Scan intent is invalid.');
    // The Slow list is checked only from indexed sources, never over a running scan.
    if (options.intent === 'slow' && (!indexedFresh || busy)) return;
    const continuationScope = {
      jobId: checkpoint?.jobId ?? storedJobId,
      revision: checkpoint || boundedSaved ? checkpointRevision : summaryCheckpointRevision,
    };
    const priorCheckpoint = checkpoint;
    const priorReview = review;
    const priorCapturedSources = capturedSources;
    const priorQuery = activeAutomaticQuery;
    const priorSavedState = {
      boundedSaved,
      storedJobId,
      checkpointRevision,
      summaryCheckpointRevision,
      savedSummary,
    };
    const priorCounts = {
      total: scanTotal,
      checked: scanChecked,
      responded: scanResponded,
      published: scanPublished,
    };
    const priorStatus = status.textContent ?? '';
    const requested = options.query === undefined ? undefined : normalizedScanQuery(options.query);
    if (options.presentation !== undefined && !['inline', 'dialog'].includes(options.presentation))
      throw new Error('Scan presentation is invalid.');
    if (closed || suspension || stopWork || boundedCleanupRefusal) return;
    // Presentation is observational: a refused new query must still reach the requested UI.
    automaticPresentation = options.presentation ?? automaticPresentation;
    if (checkpoint) automaticMode = true;
    if (automaticMode) showAutomatic();
    if ((busy || (!indexedFresh && (checkpoint || boundedSaved))) && !queryMatches(requested))
      return;
    if (scopeRefusal) {
      scopeRefusal = null;
      error.textContent = '';
    }
    if (busy) {
      if (automaticMode) showAutomatic();
      notifyProgress();
      return;
    }
    if (!continuing && boundedSaved && !indexedFresh) {
      showAutomatic();
      notifyProgress();
      return;
    }
    if (continuing && resumeRefusal !== undefined) {
      notifyProgress();
      return;
    }
    scopeRefusal = null;
    activeAutomaticQuery = indexedFresh
      ? (requested ?? activeAutomaticQuery)
      : (checkpoint?.review.query ?? requested ?? activeAutomaticQuery);
    backgroundPaused = false;
    fileReview = false;
    open(sources, automaticPresentation);
    automaticMode = true;
    historyMode = false;
    optionsPanel.open = false;
    query.value = activeAutomaticQuery;
    search.value = '';
    if (checkpointRestoreRefused && !continuing && !indexedFresh) {
      resumeRefusal = 'unavailable';
      error.textContent = 'Saved scan is unavailable. Use Rescan to start a new scan.';
      render();
      return;
    }
    if (
      !indexedFresh &&
      !continuing &&
      !checkpoint &&
      (!host.checkpoint || checkpointAdmissionLoaded)
    ) {
      resumeRefusal = undefined;
      runScan();
      return;
    }
    if (indexedFresh) {
      checkpoint = null;
      review = null;
      pipelineReview = null;
      capturedSources = [];
      boundedSaved = null;
      health.clear();
      selected.clear();
    }
    slowPass = options.intent === 'slow';
    scanKind =
      options.intent === 'slow'
        ? 'slow'
        : options.intent === 'continue'
          ? 'continue'
          : !indexedFresh
            ? undefined
            : options.intent === 'full-recheck'
              ? 'rescan'
              : 'refresh';
    const task = begin(false, continuing && !checkpoint && !!host.createBoundedResume);
    work = (async () => {
      let fresh = false;
      let continuedAdmitted = false;
      let boundedCleanupFailure = false;
      try {
        if (indexedFresh || (continuing && !checkpoint && host.createBoundedResume)) {
          const freshEntry = indexedFresh
            ? await host.createIndexedFreshResume!(
                {
                  ...(sources === undefined ? {} : { sources }),
                  query: requested ?? activeAutomaticQuery,
                  // The Slow list gets the whole 45 seconds; scans keep the setting.
                  budgetMs: slowPass ? 45000 : (Number(checkBudget.value) as HealthCheckBudgetMs),
                  intent:
                    options.intent === 'full-recheck'
                      ? 'full-recheck'
                      : slowPass
                        ? 'slow'
                        : 'refresh',
                },
                task.signal,
              )
            : null;
          if (freshEntry && !freshEntry.service && slowPass) {
            // An empty Slow list leaves the finished scan's summary as it was.
            task.signal.throwIfAborted();
            checkpoint = priorCheckpoint;
            review = priorReview;
            capturedSources = priorCapturedSources;
            activeAutomaticQuery = priorQuery;
            ({
              boundedSaved,
              storedJobId,
              checkpointRevision,
              summaryCheckpointRevision,
              savedSummary,
            } = priorSavedState);
            scanTotal = priorCounts.total;
            scanChecked = priorCounts.checked;
            scanResponded = priorCounts.responded;
            scanPublished = priorCounts.published;
            scanPhase = 'completed';
            status.textContent = priorStatus;
            return;
          }
          if (freshEntry && !freshEntry.service) {
            task.signal.throwIfAborted();
            checkpoint = null;
            review = null;
            boundedSaved = null;
            storedJobId = null;
            scanTotal = scanChecked = scanResponded = scanPublished = 0;
            scanPhase = 'completed';
            status.textContent =
              'Sources updated. No new or due channels need checking. Saved channels are retained.';
            return;
          }
          const service = freshEntry
            ? freshEntry.service
            : await host.createBoundedResume!(
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
            boundedResume = service;
            let unsubscribe: (() => void) | undefined;
            let operationFailure: { error: unknown } | undefined;
            try {
              await (async () => {
                task.signal.throwIfAborted();
                const plan: BoundedScanResumePlan = validateBoundedScanResumePlan(
                  await service.prepare(),
                );
                task.signal.throwIfAborted();
                if (closed || task.generation !== owner)
                  throw new DOMException('Scan entry canceled.', 'AbortError');
                if (
                  (!indexedFresh &&
                    continuationScope.jobId !== null &&
                    continuationScope.jobId !== plan.jobId) ||
                  (!indexedFresh &&
                    continuationScope.revision !== undefined &&
                    continuationScope.revision !== plan.revisions.checkpointRevision) ||
                  host.platform?.() !== plan.platform ||
                  host.observerProfile?.(plan.budgetMs) !== plan.observerProfile ||
                  (host.now?.() ?? Date.now()) < plan.createdAtMs ||
                  (host.now?.() ?? Date.now()) - plan.createdAtMs >= 86400000
                )
                  throw new ContinueRefusal('changed');
                if (
                  plan.counts.checked === plan.counts.total &&
                  plan.counts.published === plan.counts.responded
                )
                  throw new ContinueRefusal('completed');
                // Only scalars are retained here. No runtime checkpoint/review or health map is hydrated.
                if (indexedFresh) {
                  checkpoint = null;
                  review = null;
                  pipelineReview = null;
                  capturedSources = [];
                  health.clear();
                  selected.clear();
                }
                activeAutomaticQuery = plan.query;
                continuedAdmitted = true;
                resumeRefusal = undefined;
                checkpointRestoreRefused = false;
                checkpointAdmissionLoaded = true;
                storedJobId = plan.jobId;
                checkpointRevision = plan.revisions.checkpointRevision;
                boundedSaved = { jobId: plan.jobId, query: plan.query, completed: false };
                const update = (value: ReturnType<BoundedSourceScanResume['snapshot']>) => {
                  if (task.generation !== owner) return;
                  scanTotal = value.counts.total;
                  scanChecked = value.counts.checked;
                  scanResponded = value.counts.responded;
                  scanPublished = value.counts.published;
                  if (value.revisions) checkpointRevision = value.revisions.checkpointRevision;
                  if (value.phase !== 'disposed') {
                    boundedSaved!.completed = value.phase === 'completed';
                    scanPhase =
                      value.phase === 'completed'
                        ? 'completed'
                        : value.phase === 'checking'
                          ? 'checking'
                          : value.phase === 'failed' || value.phase === 'quarantined'
                            ? 'failed'
                            : 'paused';
                  }
                  if (value.failure !== 'none')
                    lastFailure =
                      value.failure === 'commit-unconfirmed'
                        ? 'publish-failed'
                        : value.failure === 'cleanup-unconfirmed'
                          ? 'cancel-ack'
                          : 'other';
                  if (!closed) {
                    const label = slowPass
                      ? scanPhase === 'completed'
                        ? 'Slow channels checked'
                        : scanPhase === 'failed'
                          ? 'Slow channel check stopped'
                          : scanPhase === 'paused'
                            ? 'Slow channel check paused'
                            : 'Checking slow channels in the background'
                      : scanPhase === 'completed'
                        ? 'Scan complete'
                        : scanPhase === 'failed'
                          ? 'Scan stopped'
                          : scanPhase === 'paused'
                            ? 'Scan paused'
                            : 'Checking channels';
                    status.textContent = `${label} | ${scanChecked} of ${scanTotal} checked | ${scanPublished} saved.`;
                    error.textContent =
                      value.failure === 'commit-unconfirmed'
                        ? 'Saving scan progress could not be confirmed. Select Finish scan to read saved progress before retrying. Saved channels are retained.'
                        : value.failure === 'cleanup-unconfirmed'
                          ? 'Scan cleanup could not be confirmed. Reopen the app before continuing. Saved channels are retained.'
                          : value.failure === 'probe-unconfirmed'
                            ? // Unconfirmed checks are retried later; while the scan
                              // is still running this is progress, not an error.
                              ['completed', 'failed', 'paused'].includes(scanPhase)
                              ? 'Some checks were not confirmed. Finish scan to retry unfinished channels. Your saved channels are retained.'
                              : ''
                            : value.failure === 'admission-failed'
                              ? 'The scan could not restart. Select Finish scan to check saved progress, or Rescan to check your current sources.'
                              : scanPhase === 'failed'
                                ? 'Scan stopped before completion. Select Finish scan to check saved progress. Saved channels are retained.'
                                : '';
                    render();
                  }
                };
                update({ ...service.snapshot(), counts: plan.counts, revisions: plan.revisions });
                if (!queryMatches(requested)) {
                  scanPhase = 'paused';
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
              if (boundedResume === service) boundedResume = null;
            } catch (failure) {
              boundedCleanupFailure = true;
              boundedCleanupRefusal = { service, error: failure };
              throw failure;
            } finally {
              unsubscribe?.();
            }
            if (operationFailure) throw operationFailure.error;
            return;
          }
          task.signal.throwIfAborted();
          if (indexedFresh || boundedSaved) throw new ContinueRefusal('unavailable');
        }
        fresh = await loadAutomaticCheckpoint(task, continuing ? continuationScope : undefined);
        if (continuing) {
          if (fresh || !checkpoint) throw new ContinueRefusal('missing');
          const state = automaticEntryState(true);
          if (state === 'completed') throw new ContinueRefusal('completed');
          if (state !== 'unfinished') throw new ContinueRefusal('changed');
          resumeRefusal = undefined;
          continuedAdmitted = true;
        }
        if (fresh) return;
        if (!queryMatches(requested)) {
          scanPhase = 'paused';
          return;
        }
        activeAutomaticQuery = checkpoint!.review.query;
        await checkCaptured(checkpoint!.review, task, true);
        await persistCheckpoint();
      } catch (failure) {
        if (boundedCleanupFailure) {
          recordFailure(failure);
          scanPhase = 'failed';
          lastFailure = 'cancel-ack';
          status.textContent = 'Scan stopped. Cleanup could not be confirmed.';
          error.textContent =
            'Scan cleanup could not be confirmed. Reopen the app before continuing. Saved channels are retained.';
          throw failure;
        }
        if (indexedFresh && failure instanceof SourceSnapshotFullRecheckEmptyError) {
          // This exact native refusal proves activation left the prior owner intact.
          // Restore only its existing UI scalars; never reload a complete review graph.
          checkpoint = priorCheckpoint;
          review = priorReview;
          capturedSources = priorCapturedSources;
          activeAutomaticQuery = priorQuery;
          boundedSaved = priorSavedState.boundedSaved;
          storedJobId = priorSavedState.storedJobId;
          checkpointRevision = priorSavedState.checkpointRevision;
          summaryCheckpointRevision = priorSavedState.summaryCheckpointRevision;
          savedSummary = priorSavedState.savedSummary;
          scanTotal = priorCounts.total;
          scanChecked = priorCounts.checked;
          scanResponded = priorCounts.responded;
          scanPublished = priorCounts.published;
          scanPhase = 'paused';
          status.textContent =
            'Full recheck found no matching channels. Previous scan progress is retained.';
          error.textContent = failure.message;
          return;
        }
        if (continuing && !continuedAdmitted && !task.signal.aborted && !closed) {
          resumeRefusal = failure instanceof ContinueRefusal ? failure.reason : 'unavailable';
          checkpointRestoreRefused = true;
          checkpoint = priorCheckpoint;
          review = priorReview;
          capturedSources = priorCapturedSources;
          activeAutomaticQuery = priorQuery;
          scanTotal = priorCounts.total;
          scanChecked = priorCounts.checked;
          scanResponded = priorCounts.responded;
          scanPublished = priorCounts.published;
          scanPhase = 'failed';
          lastFailure = 'other';
          status.textContent = `Previous saved scan${priorQuery ? ` for “${priorQuery}”` : ''} | ${scanChecked} of ${scanTotal} checked | ${scanPublished} saved. This saved scan cannot continue. Select Rescan to check sources again.`;
          error.textContent =
            failure instanceof ScanSourcesChanged
              ? `${failure.message} Its ${scanPublished} saved channels are kept; Rescan checks the updated sources.`
              : 'Saved scan progress is unavailable for Finish scan.';
          return;
        }
        recordFailure(failure);
        status.textContent = 'Scan stopped. Added channels retained.';
        error.textContent =
          lastFailure === 'publish-failed'
            ? 'Channels could not be saved. Saved channels are safe; Finish scan retries from the last saved progress.'
            : task.signal.aborted && lastFailure === 'canceled'
              ? ''
              : 'Scan could not resume. Rescan to check the current sources.';
      } finally {
        finish(task.generation);
        if (fresh && !continuing && !closed && !task.signal.aborted) runScan();
      }
    })();
  }
  function continueAutomatic(
    options: Pick<AutomaticScanOptions, 'presentation'> = {},
  ): Promise<void> {
    if (continueWork) return continueWork;
    if (closed || suspension) return Promise.resolve();
    if (stopWork) return stopWork;
    if (busy) {
      automaticPresentation = options.presentation ?? automaticPresentation;
      showAutomatic();
      notifyProgress();
      return Promise.resolve();
    }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const pending = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    continueWork = pending;
    const settle = () => {
      if (continueWork === pending) continueWork = null;
    };
    void pending.then(settle, settle);
    try {
      startAutomatic(undefined, { ...options, intent: 'continue' });
      void work.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return pending;
  }
  function stopAutomatic(): Promise<void> {
    if (stopWork) return stopWork;
    if (!automaticMode || closed || (resumeRefusal !== undefined && !busy && !pendingPublications))
      return Promise.resolve();
    backgroundPaused = false;
    const pending = work;
    const pendingSuspension = suspension;
    // Reserve the owner before abort callbacks can synchronously request Stop/Continue.
    const stopping = Promise.resolve()
      .then(async () => {
        if (!saving) controller?.abort();
        await boundedResume?.suspend();
        await pending;
        await pendingSuspension;
        if (checkpoint) {
          // An admitted observation can wait on publisher capacity, then miss
          // progress notification when Stop aborts. Joined settled membership
          // is authoritative; canceled/refused checks were never retained here.
          scanChecked = checkpoint.observations.size;
          scanResponded = 0;
          for (const observation of checkpoint.observations.values()) {
            health.set(observation.channelId, observation);
            if (['Reachable', 'PlayedHere'].includes(observation.verdict)) scanResponded++;
          }
          scanPublished = checkpoint.published.size;
        }
        await persistCheckpoint();
      })
      .finally(() => {
        if (stopWork === stopping) stopWork = null;
        host.activity?.(false);
        render();
      });
    stopWork = stopping;
    status.textContent = 'Stopping scan and saving progress…';
    render();
    return stopping;
  }
  return {
    snapshot,
    prepareAutomaticEntry,
    presentSavedSummary(raw, expectedGeneration) {
      if (
        closed ||
        disposed ||
        busy ||
        saving ||
        stopWork ||
        suspension ||
        entryWork ||
        pendingPublications ||
        owner !== expectedGeneration ||
        !Number.isSafeInteger(expectedGeneration) ||
        expectedGeneration < 0 ||
        checkpointAdmissionLoaded ||
        checkpoint ||
        review ||
        pipelineReview ||
        dialog.open ||
        savedSummary !== undefined
      )
        return false;
      let summary: ScanCheckpointSummary;
      try {
        summary = validateScanCheckpointSummary(raw);
      } catch {
        return false;
      }
      if (summary.checkpointStatus === 'absent') return true;
      automaticMode = true;
      automaticPresentation = 'inline';
      summaryCheckpointRevision = summary.checkpointRevision;
      savedSummary =
        summary.checkpointStatus === 'invalid'
          ? 'invalid'
          : summary.unfinished
            ? 'unfinished'
            : 'completed';
      scanPhase =
        savedSummary === 'invalid'
          ? 'failed'
          : savedSummary === 'unfinished'
            ? 'paused'
            : 'completed';
      scanTotal = summary.total;
      scanChecked = summary.checked;
      scanResponded = summary.responded;
      scanPublished = summary.published;
      status.textContent =
        savedSummary === 'invalid'
          ? 'Saved scan progress is unavailable. Existing channels are retained. Select Rescan to check sources again.'
          : savedSummary === 'completed'
            ? `Saved scan finished | ${summary.checked} of ${summary.total} checked | ${summary.published} saved. Select Refresh to look for new channels, or Rescan to check everything again.`
            : `Saved scan | ${summary.checked} of ${summary.total} checked | ${summary.published} saved. Finish scan checks whether this progress can safely resume.`;
      error.textContent = savedSummary === 'invalid' ? 'Saved scan progress is unavailable.' : '';
      notifyProgress();
      return true;
    },
    open,
    reviewFile(source, file) {
      if (closed || busy || stopWork || suspension) return Promise.resolve();
      const definition = { source: structuredClone(source), fingerprint: crypto.randomUUID() };
      open([definition]);
      fileReview = true;
      historyMode = false;
      page = 0;
      search.value = '';
      query.value = '';
      automaticChecksComplete = true;
      const task = begin();
      status.textContent = 'Reading your playlist file…';
      work = (async () => {
        try {
          if (source.kind !== 'file' || !host.readFileSnapshot)
            throw new Error('Local playlist review is unavailable.');
          if (file.size > 20 * 1024 * 1024) throw new Error('Playlist exceeds the 20 MiB limit.');
          // Capture the catalog/source revision before the noncancelable File read starts.
          const snapshot = host.capture([definition]);
          capturedSources = structuredClone(snapshot.sources);
          sourceLabels = new Map(snapshot.sources.map(({ source }) => [source.id, source.name]));
          const parsed = await host.readFileSnapshot(file, definition.source, task.signal);
          task.signal.throwIfAborted();
          if (snapshot.revision !== host.revision())
            throw new Error('Saved channels changed. Choose the file again.');
          const result = await scanConfiguredSources(snapshot.sources, async () => parsed, {
            sessionRevision: snapshot.revision,
            query: '',
            signal: task.signal,
          });
          task.signal.throwIfAborted();
          if (closed || task.generation !== owner) return;
          review = result;
          scanTotal = result.candidates.length;
          pipelineReview = null;
          health.clear();
          healthScope = null;
          selected.clear();
          for (const candidate of result.candidates) selected.add(candidate.key);
          status.textContent = `${result.candidates.length} channels ready for review. Streams have not been checked. Save to add the selected channels.`;
        } catch (failure) {
          if (task.generation === owner) recordFailure(failure);
          if (!closed && task.generation === owner) {
            status.textContent = 'File was not saved.';
            error.textContent = task.signal.aborted
              ? 'File review canceled. Choose the file again when ready.'
              : failure instanceof Error && !/https?:\/\//i.test(failure.message)
                ? failure.message
                : 'Playlist file could not be read. Choose a valid playlist file.';
          }
        } finally {
          finish(task.generation);
        }
      })();
      return work;
    },
    start(sources) {
      open(sources);
      runScan();
    },
    get automaticQuery() {
      return checkpoint?.review.query ?? activeAutomaticQuery;
    },
    startAutomatic,
    async refreshAutomatic(sources, options = {}) {
      startAutomatic(sources, options);
      await work;
    },
    continueAutomatic,
    rescanAutomatic,
    stopAutomatic,
    async resume() {
      await suspension;
      if (closed || !backgroundPaused || busy) return;
      backgroundPaused = false;
      const visible = dialog.open;
      if (boundedSaved) await continueAutomatic({ presentation: automaticPresentation });
      else startAutomatic();
      if (!visible && dialog.open) dialog.close();
    },
    suspend() {
      if (stopWork) return stopWork;
      if (suspension) return suspension;
      if (closed || !busy) return Promise.resolve();
      backgroundPaused = automaticMode;
      host.activity?.(false);
      const pending = work;
      const writing = saving;
      const restore = restoreSuspendedReview;
      if (!writing) controller?.abort();
      suspension = Promise.resolve()
        .then(async () => {
          await boundedResume?.suspend();
          await pending;
        })
        .then(async () => {
          if (automaticMode) await persistCheckpoint();
          if (closed || writing) return;
          restore?.();
          status.textContent =
            'Operation canceled while the app was in the background. Reviewed choices retained; retry when ready.';
          error.textContent = '';
          render();
        })
        .finally(() => {
          suspension = null;
        });
      return suspension;
    },
    async dispose() {
      if (disposed) return;
      closed = true;
      backgroundPaused = false;
      host.activity?.(false);
      if (!saving) controller?.abort();
      const retained = boundedResume;
      if (retained) await retained.dispose();
      async function join(pending: Promise<void> | null): Promise<void> {
        try {
          await pending;
        } catch (error) {
          // Ignore only this exact historical cleanup refusal, after its retained
          // native owner has now confirmed close. Other operation failures remain errors.
          if (
            !retained ||
            boundedCleanupRefusal?.service !== retained ||
            boundedCleanupRefusal.error !== error
          )
            throw error;
        }
      }
      await join(suspension);
      await join(work);
      await join(stopWork);
      if (boundedResume === retained) boundedResume = null;
      boundedCleanupRefusal = null;
      dialog.close();
      dialog.remove();
      trigger.remove();
      disposed = true;
    },
  };
}
