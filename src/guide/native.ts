import {
  validateChannelCoverageRequest,
  validateChannelCoverageReply,
  type ChannelCoverageRequest,
  type ChannelCoverageReply,
} from './channel-coverage';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { GUIDE_SOURCE_LIMIT } from './limits';
import { boundedUtf8Text } from '../platform/bounded-text';
import { validateGuideCategories, type GuideCategory } from './categories';
import { validateReviewedGuideAliases, type GuideCommitAliases } from './reviewed-aliases';
import { previewProposedNativeGuide } from './proposed-preview';
export type { ProposedGuidePreview } from './proposed-preview';
export type { GuideCategory } from './categories';
export interface SelectedGuideQuery {
  catalogSourceId: string;
  appChannelId: string;
  atMs: number;
  requestId: string;
}
export interface DailyGuidePlan {
  nowMs: number;
  sources: { sourceId: string; sourceRevision: number; nextDueMs: number }[];
}
export interface DailyGuideRefreshResult {
  requestId: string;
  sourceId: string;
  sourceRevision: number;
  status: 'refreshed' | 'not-modified' | 'not-due' | 'deferred';
  nextDueMs: number;
  updatedMs: number | null;
}
export async function readDailyGuidePlan(signal: AbortSignal): Promise<DailyGuidePlan> {
  signal.throwIfAborted();
  const plan = await call<DailyGuidePlan>('guide_refresh_plan');
  signal.throwIfAborted();
  if (
    !plan ||
    !Number.isSafeInteger(plan.nowMs) ||
    plan.nowMs < 0 ||
    !Array.isArray(plan.sources) ||
    plan.sources.length > GUIDE_SOURCE_LIMIT ||
    plan.sources.some(
      (entry) =>
        !entry ||
        !summaryId(entry.sourceId, 256) ||
        !Number.isSafeInteger(entry.sourceRevision) ||
        entry.sourceRevision < 1 ||
        !Number.isSafeInteger(entry.nextDueMs) ||
        entry.nextDueMs < 0,
    )
  )
    throw new Error('The daily program guide schedule is invalid.');
  return plan;
}
export async function refreshDailyGuide(
  entry: DailyGuidePlan['sources'][number],
  signal: AbortSignal,
): Promise<DailyGuideRefreshResult> {
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  let cancellation: Promise<unknown> | null = null;
  let cancellationError: unknown = null;
  const cancel = () => {
    cancellation = invoke('cancel_playlist', { requestId }).catch((error: unknown) => {
      cancellationError = error;
    });
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await call<DailyGuideRefreshResult>('guide_refresh_due', {
      sourceId: entry.sourceId,
      expectedRevision: entry.sourceRevision,
      requestId,
    });
    if (
      !result ||
      result.requestId !== requestId ||
      result.sourceId !== entry.sourceId ||
      !['refreshed', 'not-modified', 'not-due', 'deferred'].includes(result.status) ||
      !Number.isSafeInteger(result.nextDueMs) ||
      result.nextDueMs < 0 ||
      !Number.isSafeInteger(result.sourceRevision) ||
      result.sourceRevision < entry.sourceRevision ||
      (result.status === 'not-modified' &&
        (result.sourceRevision !== entry.sourceRevision || result.updatedMs === null)) ||
      (result.updatedMs !== null &&
        (!Number.isSafeInteger(result.updatedMs) || result.updatedMs < 0))
    )
      throw new Error('The daily program guide update receipt is invalid.');
    return result;
  } catch (error) {
    if (signal.aborted) throw new DOMException('Program guide update canceled.', 'AbortError');
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    await Promise.resolve(cancellation).then(() => {
      if (cancellationError) throw new Error('Program guide cancellation could not be confirmed.');
    });
  }
}
export interface SelectedGuideProgram {
  title: string;
  startMs: number;
  stopMs: number | null;
}
export interface SelectedGuideSummary extends SelectedGuideQuery {
  catalogRevision: string;
  databaseRevision: number;
  mappingStatus: 'mapped' | 'unmapped' | 'channel-unavailable' | 'source-unavailable';
  mapping: GuideMapping | null;
  sourceRevision: number | null;
  publishedRevision: number | null;
  updatedMs: number | null;
  coverage: { startMs: number | null; endMs: number | null };
  cacheStatus: 'current' | 'stale' | 'unavailable';
  currentStatus: 'current' | 'overlap' | 'unknown-end' | 'gap' | 'empty' | null;
  nextStatus: 'next' | 'overlap' | 'none' | null;
  current: SelectedGuideProgram | null;
  next: SelectedGuideProgram | null;
}
export class SelectedGuideUnavailableError extends Error {
  constructor() {
    super('Program guide requires the installed app.');
    this.name = 'SelectedGuideUnavailableError';
  }
}
const summaryInvalid = () =>
  new Error('Program guide response was invalid. Retry or review Guide.');
const summaryRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const summaryInstant = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= -62135596800000 && (v as number) <= 253402300799999;
const summaryRevision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const summaryId = (v: unknown, max: number): v is string =>
  boundedUtf8Text(v, max, true) && v.length > 0;
function validateSelectedQuery(query: SelectedGuideQuery): void {
  if (
    !summaryId(query.catalogSourceId, 256) ||
    !summaryId(query.appChannelId, 16384) ||
    !summaryInstant(query.atMs) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(query.requestId)
  )
    throw summaryInvalid();
}
export function validateSelectedGuideSummary(
  value: unknown,
  query: SelectedGuideQuery,
): SelectedGuideSummary {
  validateSelectedQuery(query);
  if (!summaryRecord(value)) throw summaryInvalid();
  const v = value;
  const allowed = [
    'catalogSourceId',
    'appChannelId',
    'atMs',
    'requestId',
    'catalogRevision',
    'databaseRevision',
    'mappingStatus',
    'mapping',
    'sourceRevision',
    'publishedRevision',
    'updatedMs',
    'coverage',
    'cacheStatus',
    'currentStatus',
    'nextStatus',
    'current',
    'next',
  ];
  if (Object.keys(v).some((key) => !allowed.includes(key))) throw summaryInvalid();
  let serialized: string;
  try {
    serialized = JSON.stringify(v);
  } catch {
    throw summaryInvalid();
  }
  if (
    new TextEncoder().encode(serialized).byteLength > 128 * 1024 ||
    v.catalogSourceId !== query.catalogSourceId ||
    v.appChannelId !== query.appChannelId ||
    v.atMs !== query.atMs ||
    v.requestId !== query.requestId ||
    typeof v.catalogRevision !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(v.catalogRevision) ||
    BigInt(v.catalogRevision) > 9223372036854775807n ||
    !summaryRevision(v.databaseRevision) ||
    !['mapped', 'unmapped', 'channel-unavailable', 'source-unavailable'].includes(
      String(v.mappingStatus),
    ) ||
    !['current', 'stale', 'unavailable'].includes(String(v.cacheStatus)) ||
    !(v.sourceRevision === null || summaryRevision(v.sourceRevision)) ||
    !(v.publishedRevision === null || summaryRevision(v.publishedRevision)) ||
    !(v.updatedMs === null || summaryInstant(v.updatedMs)) ||
    !summaryRecord(v.coverage) ||
    Object.keys(v.coverage).some((key) => !['startMs', 'endMs'].includes(key)) ||
    !(v.coverage.startMs === null || summaryInstant(v.coverage.startMs)) ||
    !(v.coverage.endMs === null || summaryInstant(v.coverage.endMs)) ||
    (typeof v.coverage.startMs === 'number' &&
      typeof v.coverage.endMs === 'number' &&
      v.coverage.endMs <= v.coverage.startMs) ||
    (typeof v.sourceRevision === 'number' &&
      typeof v.publishedRevision === 'number' &&
      v.publishedRevision > v.sourceRevision)
  )
    throw summaryInvalid();
  if (v.mapping !== null) {
    if (
      !summaryRecord(v.mapping) ||
      Object.keys(v.mapping).some(
        (key) =>
          !['catalogSourceId', 'appChannelId', 'guideSourceId', 'xmltvChannelId'].includes(key),
      ) ||
      v.mapping.catalogSourceId !== query.catalogSourceId ||
      v.mapping.appChannelId !== query.appChannelId ||
      !summaryId(v.mapping.guideSourceId, 256) ||
      !summaryId(v.mapping.xmltvChannelId, 16384)
    )
      throw summaryInvalid();
  }
  const program = (p: unknown): SelectedGuideProgram | null => {
    if (p === null) return null;
    if (
      !summaryRecord(p) ||
      Object.keys(p).some((key) => !['title', 'startMs', 'stopMs'].includes(key)) ||
      !summaryId(p.title, 16384) ||
      !summaryInstant(p.startMs) ||
      !(p.stopMs === null || (summaryInstant(p.stopMs) && p.stopMs > p.startMs))
    )
      throw summaryInvalid();
    return { title: p.title, startMs: p.startMs, stopMs: p.stopMs };
  };
  const current = program(v.current);
  const next = program(v.next);
  if (v.mappingStatus === 'mapped') {
    if (
      v.mapping === null ||
      v.sourceRevision === null ||
      !['current', 'overlap', 'unknown-end', 'gap', 'empty'].includes(String(v.currentStatus)) ||
      !['next', 'overlap', 'none'].includes(String(v.nextStatus)) ||
      (v.currentStatus === 'current') !== (current !== null) ||
      (v.nextStatus === 'next') !== (next !== null) ||
      (current &&
        (current.stopMs === null ||
          current.startMs > query.atMs ||
          current.stopMs <= query.atMs)) ||
      (next && (next.startMs <= query.atMs || next.startMs >= query.atMs + 7 * 86400000)) ||
      (v.cacheStatus === 'current' &&
        (v.publishedRevision !== v.sourceRevision || v.updatedMs === null))
    )
      throw summaryInvalid();
  } else if (
    v.currentStatus !== null ||
    v.nextStatus !== null ||
    current !== null ||
    next !== null ||
    v.cacheStatus !== 'unavailable' ||
    (v.mappingStatus !== 'source-unavailable' && v.mapping !== null)
  )
    throw summaryInvalid();
  return structuredClone({ ...v, current, next }) as unknown as SelectedGuideSummary;
}
export function createSelectedGuideAdapter(transport: {
  isNative(): boolean;
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}) {
  return async (query: SelectedGuideQuery, signal: AbortSignal): Promise<SelectedGuideSummary> => {
    signal.throwIfAborted();
    validateSelectedQuery(query);
    if (!transport.isNative()) throw new SelectedGuideUnavailableError();
    let cancellation: Promise<unknown> | null = null;
    const cancel = () => {
      cancellation ??= Promise.resolve().then(() =>
        transport.invoke('cancel_playlist', { requestId: query.requestId }),
      );
      void cancellation.catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    let value: unknown;
    let failed = false;
    try {
      value = await transport.invoke('guide_selected_summary', { ...query });
    } catch {
      failed = true;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    if (cancellation) {
      try {
        await cancellation;
      } catch {
        throw new Error('Program guide cancellation could not finish. Retry closing.');
      }
    }
    if (signal.aborted) throw new DOMException('Program guide canceled.', 'AbortError');
    if (failed) throw new Error('Program guide could not refresh. Retry or review Guide.');
    return validateSelectedGuideSummary(value, query);
  };
}
export const readSelectedGuide = createSelectedGuideAdapter({
  isNative: isTauri,
  invoke: (command, args) => invoke(command, args),
});
export class ChannelCoverageCleanupError extends Error {
  constructor() {
    super('Program guide cancellation could not finish. Retry closing.');
    this.name = 'ChannelCoverageCleanupError';
  }
}
export function createChannelCoverageAdapter(transport: {
  isNative(): boolean;
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}) {
  return async (
    query: ChannelCoverageRequest,
    signal: AbortSignal,
  ): Promise<ChannelCoverageReply> => {
    signal.throwIfAborted();
    query = validateChannelCoverageRequest(query);
    const requestId = crypto.randomUUID();
    if (!transport.isNative()) throw new SelectedGuideUnavailableError();
    let cancellation: Promise<unknown> | null = null;
    const cancel = () => {
      cancellation ??= Promise.resolve().then(() =>
        transport.invoke('cancel_playlist', { requestId }),
      );
      void cancellation.catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    let value: unknown;
    let failed = false;
    try {
      value = await transport.invoke('guide_channel_coverage', { query, requestId });
    } catch {
      failed = true;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    if (cancellation) {
      try {
        await cancellation;
      } catch {
        throw new ChannelCoverageCleanupError();
      }
    }
    if (signal.aborted) throw new DOMException('Program guide canceled.', 'AbortError');
    if (failed) throw new Error('Program guide could not refresh. Retry or review Guide.');
    return validateChannelCoverageReply(value, query);
  };
}
export const readChannelGuideCoverage = createChannelCoverageAdapter({
  isNative: isTauri,
  invoke: (command, args) => invoke(command, args),
});
export interface GuideSource {
  id: string;
  name: string;
  location: string;
  kind: 'url' | 'file';
  allowHttp: boolean;
  revision: number;
  updatedMs: number | null;
}
export interface GuideMapping {
  catalogSourceId: string;
  appChannelId: string;
  guideSourceId: string;
  xmltvChannelId: string;
}
export interface GuideCursor {
  queryKey: string;
  guideSourceId: string;
  sourceRevision: number;
  databaseRevision: number;
  startMs: number;
  ordinal: number;
  appChannelId: string;
}
export interface MappedProgram {
  catalogSourceId: string;
  appChannelId: string;
  guideSourceId: string;
  xmltvChannelId: string;
  startMs: number;
  stopMs: number | null;
  title: string;
  description: string | null;
  categories?: GuideCategory[];
  ordinal: number;
}
export interface ProgramQuery {
  guideSourceId: string;
  appChannelIds: string[];
  windowStartMs: number;
  windowEndMs: number;
  contextAtMs?: number;
  search: string;
  pageSize: number;
  cursor: GuideCursor | null;
}
export interface ProgramPage {
  programs: MappedProgram[];
  nextCursor: GuideCursor | null;
  sourceRevision: number;
  databaseRevision: number;
}
export function validateProgramPageCategories(page: ProgramPage): ProgramPage {
  if (!page || !Array.isArray(page.programs) || page.programs.length > 100)
    throw new Error('Invalid program page.');
  return {
    ...page,
    programs: page.programs.map((program) => {
      if (!program || typeof program !== 'object') throw new Error('Invalid program page.');
      return { ...program, categories: validateGuideCategories(program.categories) };
    }),
  };
}
export interface GuideChannelPage {
  channels: { id: string; names: string[] }[];
  nextCursor: GuideChannelCursor | null;
  sourceRevision: number;
}
export interface GuideChannelCursor {
  sourceRevision: number;
  queryKey: string;
  lastId: string;
}
export interface GuidePreview {
  ticket: string;
  sourceId: string;
  sourceRevision: number;
  channels: number;
  programs: number;
  firstStartMs: number | null;
  lastStartMs: number | null;
  lastKnownStopMs: number | null;
}
export interface SourceCoverage {
  /** Optional native capability: exact, current, nonremoved mapped XMLTV targets. */
  mappedTargets?: {
    version: 1;
    assessedMs: number;
    targetCount: number;
    knownEndCount: number;
    missingEndCount: number;
    expiredCount: number;
    earliestLastStopMs: number | null;
    cooldownUntilMs: number;
  };
  /** Native retention scope covers the current saved-channel interests and window. */
  projectionCompatible?: boolean;
  /** Complete current projection's interested XMLTV IDs, independent of listing availability. */
  projectionInterestCount?: number;
  sourceRevision: number;
  publishedRevision: number | null;
  channelCount: number;
  programCount: number;
  firstStartMs: number | null;
  lastStartMs: number | null;
  lastStopMs: number | null;
  unknownEndCount: number;
}
export interface GuideSuggestionQuery {
  guideSourceId: string;
  expectedSourceRevision: number;
  expectedPublishedRevision: number | null;
  providerId: string | null;
  name: string;
}
export interface GuideSuggestions {
  sourceRevision: number;
  publishedRevision: number | null;
  cacheStatus: 'current' | 'stale' | 'unavailable';
  match: 'provider-id' | 'display-name' | 'ambiguous' | 'unmatched';
  candidateCount: number;
  candidatesPreview: { xmltvChannelId: string; displayName: string }[];
  previewComplete: boolean;
  reviewRequired: true;
}
export interface GuideReviewedCrosswalkOutcome {
  status: 'not-requested' | 'available' | 'unavailable';
  code: string | null;
  canonicalIdentities: number;
  ambiguousIdentities: number;
  cacheHit: boolean;
}
interface GuideCachedConnection {
  catalogRevision: string;
  matched: number;
  unmatched: number;
  ambiguous: number;
  preservedMappings: number;
  mappingConflictAssessment?: 'complete' | 'not-assessed';
  preservedMappingConflicts?: number | null;
  checkedSources: number;
  reviewedCrosswalk?: GuideReviewedCrosswalkOutcome;
}
function crosswalkOutcome(value: unknown): GuideReviewedCrosswalkOutcome {
  const failure = () => new Error('Program guide identity metadata outcome is invalid.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  const row = value as Record<string, unknown>;
  // Old native builds omitted this additive field. Missing means zero only;
  // an explicitly malformed count must never be accepted as legacy data.
  const hasAmbiguous = Object.hasOwn(row, 'ambiguousIdentities');
  const ambiguousIdentities = hasAmbiguous ? row.ambiguousIdentities : 0;
  const keys = [
    'status',
    'code',
    'canonicalIdentities',
    'cacheHit',
    ...(hasAmbiguous ? ['ambiguousIdentities'] : []),
  ];
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key)) ||
    !['not-requested', 'available', 'unavailable'].includes(row.status as string) ||
    !Number.isSafeInteger(row.canonicalIdentities) ||
    (row.canonicalIdentities as number) < 0 ||
    (row.canonicalIdentities as number) > 1024 ||
    !Number.isSafeInteger(ambiguousIdentities) ||
    (ambiguousIdentities as number) < 0 ||
    (ambiguousIdentities as number) > 1024 ||
    (row.canonicalIdentities as number) + (ambiguousIdentities as number) > 1024 ||
    typeof row.cacheHit !== 'boolean'
  )
    throw failure();
  const codes = [
    'guide-crosswalk-authority-invalid',
    'guide-crosswalk-cancelled',
    'guide-crosswalk-timeout',
    'guide-crosswalk-network-unavailable',
    'guide-crosswalk-destination-refused',
    'guide-crosswalk-response-refused',
    'guide-crosswalk-too-large',
    'guide-crosswalk-xml-invalid',
    'guide-crosswalk-identity-invalid',
    'guide-crosswalk-identity-conflict',
    'guide-crosswalk-hash-mismatch',
    'guide-crosswalk-parser-unavailable',
  ];
  if (
    (row.status === 'unavailable'
      ? typeof row.code !== 'string' ||
        !codes.includes(row.code) ||
        row.canonicalIdentities !== 0 ||
        ambiguousIdentities !== 0 ||
        row.cacheHit
      : row.code !== null) ||
    (row.status === 'not-requested' &&
      (row.canonicalIdentities !== 0 || ambiguousIdentities !== 0 || row.cacheHit)) ||
    (row.status === 'available' && (row.canonicalIdentities as number) === 0)
  )
    throw failure();
  return {
    status: row.status as GuideReviewedCrosswalkOutcome['status'],
    code: row.code as string | null,
    canonicalIdentities: row.canonicalIdentities as number,
    ambiguousIdentities: ambiguousIdentities as number,
    cacheHit: row.cacheHit,
  };
}
/** Native commands retain full feeds; only bounded pages and preview counts cross IPC. */
export function nativeGuideAvailable(): boolean {
  return isTauri();
}
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri())
    return Promise.reject(new Error('Program guide storage requires the installed app.'));
  return invoke<T>(command, args);
}
export const nativeGuide = {
  previewProposedSource: previewProposedNativeGuide,
  connectCached: (
    expectedCatalogRevision: string,
    sources: {
      id: string;
      location: string;
      expectedSourceRevision: number;
      expectedPublishedRevision: number;
    }[],
    aliases: readonly GuideCommitAliases[],
    requestId: string,
    cacheOnly = false,
  ) =>
    call<GuideCachedConnection>('guide_connect_cached_catalog', {
      expectedCatalogRevision,
      sources,
      aliases: aliases.map(validateReviewedGuideAliases),
      requestId,
      cacheOnly,
    }).then((receipt) => {
      if (receipt.reviewedCrosswalk === undefined) return receipt;
      return { ...receipt, reviewedCrosswalk: crosswalkOutcome(receipt.reviewedCrosswalk) };
    }),
  sources: () => call<GuideSource[]>('guide_sources'),
  saveSource: (source: GuideSource, expectedRevision: number) =>
    call<GuideSource>('guide_save_source', { source, expectedRevision }),
  removeSource: (id: string, expectedRevision: number) =>
    call<void>('guide_remove_source', { id, expectedRevision }),
  mappings: () => call<GuideMapping[]>('guide_mappings'),
  coverage: (sourceId: string) => call<SourceCoverage>('guide_coverage', { sourceId }),
  packSuggestions: () => call<unknown>('guide_pack_suggestions'),
  suggestions: (query: GuideSuggestionQuery) =>
    call<GuideSuggestions>('guide_suggest_mapping', { query }),
  saveMapping: (mapping: GuideMapping) => call<void>('guide_save_mapping', { mapping }),
  removeMapping: (catalogSourceId: string, appChannelId: string) =>
    call<void>('guide_remove_mapping', { catalogSourceId, appChannelId }),
  channels: (sourceId: string, search: string, afterId: GuideChannelCursor | null = null) =>
    call<GuideChannelPage>('guide_channels', { sourceId, search, afterId, pageSize: 50 }),
  programs: async (query: ProgramQuery) =>
    validateProgramPageCategories(await call<ProgramPage>('guide_programs', { query })),
  commit: (ticket: string, expectedRevision: number, allowEmpty = false) =>
    call<number>('guide_commit', { ticket, expectedRevision, allowEmpty }),
  commitAndMatch: (ticket: string, expectedRevision: number) =>
    call<{ sourceRevision: number; matched: number; unmatched: number; preservedMappings: number }>(
      'guide_commit_and_match',
      { ticket, expectedRevision, allowEmpty: false },
    ),
  discard: (ticket: string) => call<void>('guide_discard', { ticket }),
  commitIfMatched: (
    ticket: string,
    expectedGuideRevision: number,
    expectedCatalogRevision: string,
    aliases?: GuideCommitAliases,
  ) =>
    call<{ committed: boolean; matched: number; unmatched: number }>('guide_commit_if_matched', {
      ticket,
      expectedGuideRevision,
      expectedCatalogRevision,
      ...(aliases === undefined ? {} : { aliases: validateReviewedGuideAliases(aliases) }),
    }),
};

export async function previewNativeGuide(
  sourceId: string,
  signal: AbortSignal,
  file?: File,
): Promise<GuidePreview> {
  if (!isTauri()) throw new Error('Program guide storage requires the installed app.');
  signal.throwIfAborted();
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(sourceId))
    throw new Error('The guide source identity is invalid.');
  if (file && file.size > 20 * 1024 * 1024)
    throw new Error('Guide input exceeds the 20 MiB limit.');
  if (file && (!Number.isSafeInteger(file.size) || file.size < 0))
    throw new Error('The guide file size is invalid.');
  const requestId = crypto.randomUUID();
  let uploadId: string | undefined;
  const cancel = () => {
    void invoke('cancel_playlist', { requestId }).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    let result: GuidePreview;
    if (file) {
      const runtime = await invoke<{ platform: string }>('runtime_info');
      signal.throwIfAborted();
      if (!runtime || typeof runtime.platform !== 'string')
        throw new Error('The guide file transport is unavailable for this device.');
      if (runtime.platform === 'android') {
        const admission = await invoke<{ uploadId: string; chunkBytes: number }>(
          'guide_file_begin',
          {
            sourceId,
            requestId,
            totalBytes: file.size,
          },
        );
        if (!admission || typeof admission !== 'object')
          throw new Error('The guide upload admission is invalid.');
        if (
          typeof admission.uploadId === 'string' &&
          /^[A-Za-z0-9_-]{1,256}$/.test(admission.uploadId)
        )
          uploadId = admission.uploadId;
        if (
          !uploadId ||
          !Number.isSafeInteger(admission.chunkBytes) ||
          admission.chunkBytes < 1 ||
          admission.chunkBytes > 32768
        )
          throw new Error('The guide upload admission is invalid.');
        signal.throwIfAborted();
        for (let offset = 0; offset < file.size;) {
          const end = Math.min(file.size, offset + admission.chunkBytes);
          const chunk = await file.slice(offset, end).arrayBuffer();
          signal.throwIfAborted();
          if (chunk.byteLength !== end - offset)
            throw new Error('The guide upload chunk is incomplete.');
          const acknowledgment = await invoke<{ receivedBytes: number }>('guide_file_append', {
            uploadId,
            offset,
            bytes: Array.from(new Uint8Array(chunk)),
          });
          signal.throwIfAborted();
          if (!acknowledgment || acknowledgment.receivedBytes !== end)
            throw new Error('The guide upload acknowledgment is invalid.');
          offset = end;
        }
        result = await invoke<GuidePreview>('guide_file_finish', { uploadId });
      } else {
        if (!['windows', 'linux', 'macos', 'ios'].includes(runtime.platform))
          throw new Error('The guide file transport is unavailable for this device.');
        const bytes = await file.arrayBuffer();
        signal.throwIfAborted();
        result = await invoke<GuidePreview>('guide_preview_file', bytes, {
          headers: {
            'x-genx-guide-source': sourceId,
            'x-genx-guide-request': requestId,
          },
        });
      }
    } else {
      result = await invoke<GuidePreview>('guide_preview', { sourceId, requestId });
    }
    if (signal.aborted) {
      await nativeGuide.discard(result.ticket);
      signal.throwIfAborted();
    }
    return result;
  } catch (error) {
    // Also cancels a late/malformed admission whose usable upload handle never arrived.
    await invoke('cancel_playlist', { requestId }).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (uploadId) await invoke('guide_file_discard', { uploadId });
  }
}
