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

import { normalizeSourceMime } from '../sources';
import { reconcileChannels, validateCatalog, validateSource, type CatalogRecord } from '../catalog';
import { MAX_CHANNELS } from '../catalog/parser';
import {
  prepareTransfer,
  prepareCommitTransfer,
  validateCommitRecord,
  type PreparedTransfer,
  type PreparedCommitTransfer,
  type BackupRecord,
} from '../data-transfer';
import type { Preferences } from '../preferences';
import type { ScanSource, StagedScanSelection } from './scan';
import type { ReviewCandidate } from './scan';
import type { HealthObservation } from './health';
import { deriveCatalogPatch, type CatalogPatch } from './catalog-patch';
import {
  fingerprintHealthTarget,
  reconcileHealthRecords,
  remapReviewedHealth,
  serializeHealthPayload,
  validateHealthRecords,
  type HealthTarget,
  type PersistedHealthRecord,
  type ReviewedHealthMapping,
} from '../catalog/health-record';

export interface ReviewedScanHealthContext {
  candidates: readonly ReviewCandidate[];
  observations: readonly HealthObservation[];
  platform: string;
  observerProfile: string;
}
export interface ScanPreparationHealthOptions {
  previousHealth: readonly PersistedHealthRecord[];
  review?: ReviewedScanHealthContext;
}
export interface PreparedScanTransfer extends PreparedTransfer {
  healthText?: string;
  healthRecords?: PersistedHealthRecord[];
}
export type PreparedScanCommit = PreparedCommitTransfer;
export interface PreparedCompactScanCommit {
  schemaVersion: 1;
  catalogPatch: CatalogPatch;
  preferences: Preferences;
  catalogText: string;
  preferencesText: string;
  healthText?: string;
}
export interface PreparedNativeScanBatch {
  schemaVersion: 1;
  catalogPatch: CatalogPatch;
  nextPreferences: Preferences;
  incomingHealth: PersistedHealthRecord[];
}
/** Native-only bounded publication. Full admission stays inside the isolated worker. */
export async function prepareOwnedNativeScanBatch(
  catalogInput: CatalogRecord,
  preferences: Preferences,
  selection: StagedScanSelection,
  scope: readonly ScanSource[],
  review?: ReviewedScanHealthContext,
  signal?: AbortSignal,
): Promise<PreparedNativeScanBatch> {
  signal?.throwIfAborted();
  if (
    selection.sources.reduce((count, source) => count + source.candidates.length, 0) > 64 ||
    (review && (review.candidates.length > 64 || review.observations.length > 64))
  )
    throw new Error('Native scan batch exceeds the 64 channel bound.');
  const { prepared, mappings } = prepare(
    catalogInput,
    preferences,
    selection,
    scope,
    (input) => ({ record: validateCommitRecord(input, signal) }),
    review,
  );
  const catalogPatch = deriveCatalogPatch(catalogInput, prepared.record.catalog);
  if (catalogPatch.channels.length > 64)
    throw new Error('Native scan batch exceeds the 64 channel bound.');
  const incomingHealth = review
    ? (await remapReviewedHealth({ ...review, mappings, signal })).records
    : [];
  signal?.throwIfAborted();
  if (incomingHealth.length > 64)
    throw new Error('Native scan batch exceeds the 64 channel bound.');
  return {
    schemaVersion: 1,
    catalogPatch,
    nextPreferences: prepared.record.preferences,
    incomingHealth,
  };
}
function tuple(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** Preparation only. Selected discoveries add/update; all unselected saved records survive. */
export function prepareSelectedScan(
  catalogInput: CatalogRecord,
  preferences: Preferences,
  selection: StagedScanSelection,
  scope: readonly ScanSource[],
): PreparedTransfer {
  return prepare(catalogInput, preferences, selection, scope, prepareTransfer).prepared;
}
function prepare<T extends { record: BackupRecord }>(
  catalogInput: CatalogRecord,
  preferences: Preferences,
  selection: StagedScanSelection,
  scope: readonly ScanSource[],
  serialize: (input: BackupRecord) => T,
  review?: ReviewedScanHealthContext,
): { prepared: T; mappings: ReviewedHealthMapping[] } {
  const catalog = validateCatalog(catalogInput);
  const definitions = new Map(scope.map((entry) => [entry.source.id, entry]));
  if (
    definitions.size !== scope.length ||
    new Set(selection.sources.map((s) => s.sourceId)).size !== selection.sources.length
  )
    throw new Error('The reviewed source scope is invalid.');
  const sources = new Map(catalog.sources.map((source) => [source.id, source]));
  const channels = new Map(catalog.channels.map((channel) => [channel.id, channel]));
  const checked = new Map<string, ReviewCandidate>();
  const keys = new Set<string>();
  if (
    review &&
    (review.candidates.length > MAX_CHANNELS || review.observations.length > MAX_CHANNELS)
  )
    throw new Error('Reviewed health exceeds the selected check bound.');
  for (const candidate of review?.candidates ?? []) {
    const key = tuple(candidate.channel);
    if (
      keys.has(candidate.key) ||
      checked.has(key) ||
      candidate.sessionRevision !== selection.sessionRevision
    )
      throw new Error('Reviewed health candidate identity is invalid.');
    checked.set(key, candidate);
    keys.add(candidate.key);
  }
  const mappings: ReviewedHealthMapping[] = [];
  for (const selected of selection.sources) {
    const definition = definitions.get(selected.sourceId);
    if (
      !definition ||
      definition.fingerprint !== selected.fingerprint ||
      selection.failedSourceIds.includes(selected.sourceId)
    )
      throw new Error('The reviewed source changed. Scan it again.');
    if (selected.candidates.some((candidate) => candidate.sourceId !== selected.sourceId))
      throw new Error('A reviewed channel belongs to a different source.');
    if (!selected.candidates.length) continue;
    // Normalize legacy in-memory HTTP metadata on a copy; review fingerprints stay immutable.
    const source = validateSource({
      ...definition.source,
      ...(definition.source.mediaMime === undefined
        ? {}
        : {
            mediaMime:
              normalizeSourceMime(definition.source.mediaMime) ?? definition.source.mediaMime,
          }),
    });
    const previous = catalog.channels.filter((channel) => channel.sourceId === source.id);
    const reconciled = reconcileChannels(
      selected.candidates,
      previous,
      undefined,
      selected.reconciliationScope,
    );
    for (const [index, channel] of reconciled.entries()) {
      channels.set(channel.id, channel);
      const candidate = checked.get(tuple(selected.candidates[index]));
      if (candidate) {
        if (
          candidate.sourceId !== source.id ||
          candidate.sourceFingerprint !== definition.fingerprint
        )
          throw new Error('Reviewed health source is obsolete.');
        mappings.push({ candidate, channel, source: definition, checkedUrlOrdinal: 0 });
        checked.delete(tuple(selected.candidates[index]));
      }
    }
    sources.set(source.id, source);
  }
  const next: CatalogRecord = {
    schemaVersion: 1,
    sources: [...sources.values()],
    channels: [...channels.values()],
  };
  const prepared = serialize({
    format: 'genx-tv-backup',
    schemaVersion: 1,
    catalog: next,
    preferences: { ...preferences, sources: next.sources },
  });
  if (checked.size) throw new Error('Reviewed health includes an unselected or changed channel.');
  return { prepared, mappings };
}

/** Hashing stays off the UI thread and only visits health-referenced URL slots. */
export async function prepareSelectedScanWithHealth(
  catalogInput: CatalogRecord,
  preferences: Preferences,
  selection: StagedScanSelection,
  scope: readonly ScanSource[],
  options: ScanPreparationHealthOptions,
  signal?: AbortSignal,
): Promise<PreparedScanTransfer> {
  signal?.throwIfAborted();
  const captured = structuredClone({ catalogInput, preferences, selection, scope, options });
  return prepareHealth(
    captured,
    prepareTransfer,
    (prepared, healthRecords) => ({
      ...prepared,
      healthRecords,
      healthText: serializeHealthPayload(healthRecords),
    }),
    signal,
  );
}

/** Only the worker may use this path: postMessage already owns an isolated input snapshot. */
export async function prepareOwnedScanCommit(
  catalogInput: CatalogRecord,
  preferences: Preferences,
  selection: StagedScanSelection,
  scope: readonly ScanSource[],
  options?: ScanPreparationHealthOptions,
  signal?: AbortSignal,
): Promise<PreparedScanCommit> {
  signal?.throwIfAborted();
  if (!options)
    return prepare(catalogInput, preferences, selection, scope, prepareCommitTransfer).prepared;
  return prepareHealth(
    { catalogInput, preferences, selection, scope, options },
    prepareCommitTransfer,
    (prepared, healthRecords) => ({
      ...prepared,
      healthText: serializeHealthPayload(healthRecords),
    }),
    signal,
  );
}

/** Worker-only compact reply; native record strings and full preparation admission are unchanged. */
export async function prepareOwnedCompactScanCommit(
  catalogInput: CatalogRecord,
  preferences: Preferences,
  selection: StagedScanSelection,
  scope: readonly ScanSource[],
  options?: ScanPreparationHealthOptions,
  signal?: AbortSignal,
): Promise<PreparedCompactScanCommit> {
  const prepared = await prepareOwnedScanCommit(
    catalogInput,
    preferences,
    selection,
    scope,
    options,
    signal,
  );
  signal?.throwIfAborted();
  return {
    schemaVersion: 1,
    catalogPatch: deriveCatalogPatch(catalogInput, prepared.record.catalog),
    preferences: prepared.record.preferences,
    catalogText: prepared.catalogText,
    preferencesText: prepared.preferencesText,
    ...(prepared.healthText === undefined ? {} : { healthText: prepared.healthText }),
  };
}

async function prepareHealth<T extends PreparedCommitTransfer, R>(
  captured: {
    catalogInput: CatalogRecord;
    preferences: Preferences;
    selection: StagedScanSelection;
    scope: readonly ScanSource[];
    options: ScanPreparationHealthOptions;
  },
  serialize: (input: BackupRecord) => T,
  finish: (prepared: T, healthRecords: PersistedHealthRecord[]) => R,
  signal?: AbortSignal,
): Promise<R> {
  const previous = validateHealthRecords(captured.options.previousHealth);
  const { prepared, mappings } = prepare(
    captured.catalogInput,
    captured.preferences,
    captured.selection,
    captured.scope,
    serialize,
    captured.options.review,
  );
  const incoming = captured.options.review
    ? (await remapReviewedHealth({ ...captured.options.review, mappings, signal })).records
    : [];
  signal?.throwIfAborted();
  const slots = new Map<string, PersistedHealthRecord>();
  for (const record of [...previous, ...incoming])
    slots.set(JSON.stringify([record.channelId, record.checkedUrlOrdinal]), record);
  if (slots.size > 100000) throw new Error('Health target count exceeds bound.');
  const sources = new Map(prepared.record.catalog.sources.map((source) => [source.id, source]));
  const channels = new Map(
    prepared.record.catalog.channels.map((channel) => [channel.id, channel]),
  );
  const targets: HealthTarget[] = [];
  const entries = [...slots.values()];
  let cursor = 0;
  let failed = false;
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      try {
        while (cursor < entries.length && !failed) {
          signal?.throwIfAborted();
          const record = entries[cursor++]!;
          const channel = channels.get(record.channelId);
          const source = channel && sources.get(channel.sourceId);
          if (!channel || !source || !channel.urls[record.checkedUrlOrdinal]) continue;
          let admitted = false;
          try {
            const url = new URL(channel.urls[record.checkedUrlOrdinal]!);
            const sourceUrl = source.kind === 'url' ? new URL(source.location) : null;
            admitted = [url, ...(sourceUrl ? [sourceUrl] : [])].every(
              (value) =>
                ['https:', 'http:'].includes(value.protocol) &&
                !value.username &&
                !value.password &&
                (value.protocol !== 'http:' || source.allowHttp === true),
            );
          } catch {
            /* Invalid old target is omitted; crypto failures below remain fatal. */
          }
          if (!admitted) continue;
          const targetFingerprint = await fingerprintHealthTarget(
            source,
            channel,
            record.checkedUrlOrdinal,
          );
          signal?.throwIfAborted();
          targets.push({
            channelId: channel.id,
            sourceId: source.id,
            checkedUrlOrdinal: record.checkedUrlOrdinal,
            targetFingerprint,
          });
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    }),
  );
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  signal?.throwIfAborted();
  const healthRecords = reconcileHealthRecords(previous, incoming, targets);
  return finish(prepared, healthRecords);
}
