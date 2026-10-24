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
  collectSources,
  exactCandidateDedup,
  type CollectionProgress,
  type SourceCollectionStatus,
} from '../catalog/collector';
import {
  MAX_CHANNELS,
  channelReconciliationScope,
  type ReconciliationScope,
  type ChannelCandidate,
  type ParsedPlaylist,
  type Source,
} from '../catalog/parser';
import { declaredCategoryAliases } from '../search/category-aliases';
import { locationSearchText } from '../search/location-labels';
import { consumeOwnedCollection } from '../catalog/owned-collection';

export interface ScanSource {
  source: Source;
  fingerprint: string;
}
export interface ReviewCandidate {
  key: string;
  sourceId: string;
  sourceFingerprint: string;
  sessionRevision: string;
  channel: ChannelCandidate;
}
export interface ScanSourceResult {
  sourceId: string;
  fingerprint: string;
  status: SourceCollectionStatus;
  inspected: number;
  matched: number;
  warnings: number;
  warningMessages?: string[];
  error?: string;
}
export interface ScanReview {
  sessionRevision: string;
  query: string;
  status: 'completed' | 'canceled';
  sources: ScanSourceResult[];
  candidates: ReviewCandidate[];
  counts: { inspected: number; matched: number; failedSources: number; canceledSources: number };
}
export interface StagedScanSelection {
  sessionRevision: string;
  sources: Array<{
    sourceId: string;
    fingerprint: string;
    candidates: ChannelCandidate[];
    reconciliationScope?: ReconciliationScope;
  }>;
  /** Failed sources carry no replacement; the caller must retain prior records. */
  failedSourceIds: string[];
}
function opaque(value: string): boolean {
  return !!value.trim() && value.length <= 256 && !/https?:\/\//i.test(value);
}
/** Collection is read-only. The injected operation owns its reader/parser and abort cleanup. */
export async function scanConfiguredSources(
  sources: readonly ScanSource[],
  operation: (source: Source, signal: AbortSignal) => Promise<ParsedPlaylist>,
  options: {
    sessionRevision: string;
    query: string;
    signal: AbortSignal;
    progress?: (event: CollectionProgress) => void;
    /** Published alternate names for query matching; never identity or merge authority. */
    aliases?: (channel: ChannelCandidate) => readonly string[];
  },
): Promise<ScanReview> {
  if (
    !opaque(options.sessionRevision) ||
    options.query.length > 256 ||
    sources.length > MAX_CHANNELS ||
    new Set(sources.map(({ source }) => source.id)).size !== sources.length ||
    sources.some(({ source, fingerprint }) => !opaque(source.id) || !opaque(fingerprint))
  )
    throw new Error('Scan scope or revision is invalid.');
  const configured = sources.map(({ source, fingerprint }) => ({
    id: source.id,
    source: { ...source },
    fingerprint,
  }));
  const query = options.query.trim();
  const queryKey = query.normalize('NFKC').toLowerCase();
  const tokens = queryKey.split(/\s+/).filter(Boolean);
  let rawCandidates = 0;
  const outcomes = await collectSources(
    configured,
    async (entry, signal) => {
      const parsed = await operation({ ...entry.source }, signal);
      if (signal.aborted) return { status: 'canceled' };
      const ownedCount = consumeOwnedCollection(parsed);
      rawCandidates += ownedCount ?? parsed.channels.length;
      if (parsed.channels.some((channel) => channel.sourceId !== entry.id))
        throw new Error('Source ownership mismatch.');
      return {
        status: 'completed',
        value: {
          channels: ownedCount === null ? exactCandidateDedup(parsed.channels) : parsed.channels,
          warnings: ownedCount === null ? [...parsed.warnings] : parsed.warnings,
          owned: ownedCount !== null,
        },
      };
    },
    options.signal,
    options.progress,
  );
  const total = outcomes.reduce((sum, outcome) => sum + (outcome.value?.channels.length ?? 0), 0);
  if (rawCandidates > MAX_CHANNELS)
    throw new Error(
      'Scan exceeds the 100,000 candidate limit. Narrow the configured sources and retry.',
    );
  const candidates: ReviewCandidate[] = [];
  const results = outcomes.map((outcome): ScanSourceResult => {
    const entry = configured[outcome.index];
    let matched = 0;
    for (const [index, channel] of (outcome.value?.channels ?? []).entries()) {
      const alternates = tokens.length && options.aliases ? options.aliases(channel) : [];
      const text =
        `${channel.name} ${channel.category} ${declaredCategoryAliases(channel.category).join(' ')} ${locationSearchText(channel.geography)} ${alternates.join(' ')}`
          .normalize('NFKC')
          .toLowerCase();
      const exactProvider =
        !!queryKey && channel.providerId?.normalize('NFKC').toLowerCase() === queryKey;
      if (!exactProvider && !tokens.every((token) => text.includes(token))) continue;
      matched++;
      candidates.push({
        key: `${options.sessionRevision}:${outcome.index}:${index}`,
        sourceId: entry.id,
        sourceFingerprint: entry.fingerprint,
        sessionRevision: options.sessionRevision,
        channel: outcome.value?.owned ? channel : structuredClone(channel),
      });
    }
    return {
      sourceId: entry.id,
      fingerprint: entry.fingerprint,
      status: outcome.status,
      inspected: outcome.value?.channels.length ?? 0,
      matched,
      warnings: outcome.value?.warnings.length ?? 0,
      ...(outcome.value?.warnings.length ? { warningMessages: outcome.value.warnings } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  });
  return {
    sessionRevision: options.sessionRevision,
    query,
    status: options.signal.aborted ? 'canceled' : 'completed',
    sources: results,
    candidates,
    counts: {
      inspected: total,
      matched: candidates.length,
      failedSources: results.filter((entry) => entry.status === 'failed').length,
      canceledSources: results.filter((entry) => entry.status === 'canceled').length,
    },
  };
}

/** Capture multiplicity once before progressive batches split a reviewed source. */
export function scanReconciliationScopes(
  review: ScanReview,
): ReadonlyMap<string, ReconciliationScope> {
  if (review.candidates.length > MAX_CHANNELS)
    throw new Error('Scan reconciliation exceeds its candidate bound.');
  const grouped = new Map<string, ChannelCandidate[]>();
  for (const candidate of review.candidates) {
    const bucket = grouped.get(candidate.sourceId) ?? [];
    bucket.push(candidate.channel);
    grouped.set(candidate.sourceId, bucket);
  }
  return new Map(
    [...grouped].map(([sourceId, candidates]) => [
      sourceId,
      channelReconciliationScope(candidates, sourceId),
    ]),
  );
}

/**
 * Keys exist only within this review; they are not durable channel identities.
 * Caller atomically adds/updates selected discoveries and preserves unselected
 * existing records. Source replacement requires a separate explicit reviewed action.
 * Failed sources have no replacement. Canceled scans never stage removal/blacklisting.
 */
export function stageScanSelection(
  review: ScanReview,
  keys: readonly string[],
  currentRevision: string,
  reconciliationScopes?: ReadonlyMap<string, ReconciliationScope>,
): StagedScanSelection {
  if (review.status !== 'completed' || review.sessionRevision !== currentRevision)
    throw new Error('This scan review is obsolete or canceled. Scan again before saving.');
  const scopes = reconciliationScopes ?? scanReconciliationScopes(review);
  const selected = new Set(keys);
  const indexed = new Map(review.candidates.map((candidate) => [candidate.key, candidate]));
  if (
    keys.length > MAX_CHANNELS ||
    selected.size !== keys.length ||
    keys.some((key) => !indexed.has(key))
  )
    throw new Error('Scan selection contains obsolete or repeated candidates.');
  const groups: StagedScanSelection['sources'] = [];
  const bySource = new Map<string, ReviewCandidate[]>();
  for (const candidate of review.candidates) {
    if (!selected.has(candidate.key)) continue;
    const candidates = bySource.get(candidate.sourceId) ?? [];
    candidates.push(candidate);
    bySource.set(candidate.sourceId, candidates);
  }
  for (const source of review.sources) {
    if (source.status !== 'completed') continue;
    const candidates = bySource.get(source.sourceId) ?? [];
    if (
      candidates.some(
        (candidate) =>
          candidate.sourceFingerprint !== source.fingerprint ||
          candidate.channel.sourceId !== source.sourceId ||
          candidate.sessionRevision !== currentRevision,
      )
    )
      throw new Error('Scan candidate ownership is obsolete.');
    if (candidates.length)
      groups.push({
        sourceId: source.sourceId,
        fingerprint: source.fingerprint,
        candidates: candidates.map((candidate) => structuredClone(candidate.channel)),
        ...(scopes.has(source.sourceId)
          ? { reconciliationScope: scopes.get(source.sourceId)! }
          : {}),
      });
  }
  return {
    sessionRevision: currentRevision,
    sources: groups,
    failedSourceIds: review.sources
      .filter((source) => source.status === 'failed')
      .map((source) => source.sourceId),
  };
}
