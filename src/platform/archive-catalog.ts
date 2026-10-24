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

import { invoke, isTauri } from '@tauri-apps/api/core';
import { boundedUtf8Text } from './bounded-text';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';
import {
  publicArchiveProvider,
  publicArchiveSource,
  publicArchiveNasaItemId,
  providerPlainText,
  validateArchiveProviderFacts,
  validatePublicArchiveDiscoverRequest,
  validatePublicArchiveDiscoverReceipt,
  type PublicArchiveProvider,
  type ArchiveProviderFacts,
  type PublicArchiveDiscoverRequest,
  type PublicArchiveDiscoverReceipt,
} from './archive-public-providers';

export interface ArchiveDateAssessment {
  version: 1;
  providerListedYear: number | null;
  originalReleaseYear: null;
  status: 'unverified-item-date' | 'unknown';
  provenance: 'legacy-item-year';
  field: 'unknown';
}
export interface ArchiveTitle {
  dateAssessment?: ArchiveDateAssessment;
  providerId?: PublicArchiveProvider;
  sourceUrl?: string;
  favorite: boolean;
  titleRef: string;
  title: string;
  kind: 'tv' | 'movie';
  contentType?: ArchiveContentType;
  contentTypeProvenance?: 'provider-item' | 'unknown';
  providerSeries?: string | null;
  artwork?: ArchiveArtworkProof | null;
  releaseYear: number | null;
  curated: boolean;
  titleProvenance: 'provider-item';
  fileCount: number;
  durationSeconds: number | null;
  rights: string | null;
  rank: number;
  quality: 'metadata-h264' | 'metadata-listed';
  observedMs: number;
  /** Provider claims, never proof of the audio track or edition. */
  providerLanguages?: string[];
  languageProvenance?: 'provider-item' | 'unknown';
  providerSubjects?: string[];
  providerDescription?: string | null;
  matchBasis?: 'title' | 'series' | 'subject' | 'genre' | 'file' | 'legacy-metadata' | 'browse';
}
export interface ArchiveFile {
  providerFacts?: ArchiveProviderFacts;
  fileRef: string;
  title: string;
  fileName: string;
  itemId: string;
  format: string;
  durationSeconds: number | null;
  sizeBytes: string | null;
  availability: 'unverified' | 'reachable' | 'played' | 'dead';
  observedMs: number;
}
export interface ArchiveQuery {
  schemaVersion: 1;
  query: string;
  expectedRevision: string | null;
  offset: number;
  pageSize: number;
  curatedOnly?: boolean;
  decade?: ArchiveDecade | null;
  favoritesOnly?: boolean;
  languageMode?: ArchiveLanguageMode;
  contentType?: ArchiveContentType | 'all';
}
export type ArchiveDecade = 1960 | 1970 | 1980 | 1990 | 2000 | 2010 | 2020;
export type ArchiveContentType = 'tv' | 'movie' | 'short' | 'unknown';
export interface ArchiveArtworkProof {
  schemaVersion: 1;
  artworkRef: string;
  itemId: string;
  fileName: string;
  sizeBytes: string;
  mimeType: 'image/jpeg' | 'image/png';
  provenance: 'provider-item';
}
export interface ArchiveArtworkRequest {
  schemaVersion: 1;
  titleRef: string;
  expectedRevision: string;
}
export interface ArchiveArtworkResponse {
  schemaVersion: 1;
  titleRef: string;
  revision: string;
  artworkRef: string;
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  byteLength: number;
  dataUrl: string;
}
function decadeEnd(value: ArchiveDecade): number {
  return value === 2020 ? 2100 : value + 9;
}

export type ArchiveLanguageMode = 'all' | 'english-first' | 'english' | 'unlisted';
export interface ArchivePage {
  schemaVersion: 1;
  revision: string;
  totalCount: number;
  offset: number;
  items: ArchiveTitle[];
  more: boolean;
}
export interface ArchiveFilesQuery {
  schemaVersion: 1;
  titleRef: string;
  expectedRevision: string;
  offset: number;
  pageSize: number;
}
export interface ArchiveFilesPage {
  schemaVersion: 1;
  revision: string;
  titleRef: string;
  totalCount: number;
  offset: number;
  files: ArchiveFile[];
  more: boolean;
}
/** Captured local view only; acquisition still checks every provider language. */
export interface ArchiveDiscoveryView {
  schemaVersion: 1;
  languageMode: ArchiveLanguageMode;
  favoritesOnly: boolean;
  curatedOnly: boolean;
  contentType?: ArchiveContentType | 'all';
}
export interface ArchiveDiscoverStep {
  schemaVersion: 1;
  expectedRevision: string;
  year: number | null;
  page: number;
  query: string;
  explicitAction: true;
  restart?: boolean;
  decade?: ArchiveDecade | null;
  view?: ArchiveDiscoveryView;
}
export interface ArchiveDiscoverReceipt {
  schemaVersion: 1;
  committed: true;
  revision: string;
  year: number | null;
  page: number;
  nextPage: number | null;
  examined: number;
  admitted: number;
  /** Present only for a view-aware request; atomic newly visible title identities. */
  newVisibleMatches?: number;
  excludedUnknownYear: number;
  unavailable: number;
  titleCount: number;
  confirmedDead: number;
  transientFailures: number;
  capacityReached: boolean;
  /** Absolute epoch-millisecond retry deadline, not a duration. */
  retryAfterMs: number | null;
  rankingPolicy: 'archive-popularity-playable-v1';
  pendingFilePages: ArchiveFileProgress[];
}
export interface ArchiveFileProgress {
  titleRef: string;
  title: string;
  kind: 'tv' | 'movie';
  originalYear: number | null;
  providerFileCount: number;
  nextOffset: number;
  availableFileCount: number;
  complete: boolean;
  capacityReached: boolean;
}
export interface ArchiveFileProgressQuery {
  schemaVersion: 1;
  expectedRevision: string | null;
  offset: number;
  pageSize: number;
  query?: string;
  decade?: ArchiveDecade | null;
  favoritesOnly?: boolean;
  languageMode?: ArchiveLanguageMode;
  contentType?: ArchiveContentType | 'all';
}
export interface ArchiveFileProgressPage {
  schemaVersion: 1;
  revision: string;
  totalCount: number;
  offset: number;
  items: ArchiveFileProgress[];
  more: boolean;
}
export interface ArchiveItemFilesStep {
  schemaVersion: 1;
  titleRef: string;
  expectedRevision: string;
  expectedOffset: number;
  explicitAction: true;
  restart?: boolean;
}
export interface ArchiveItemFilesReceipt {
  schemaVersion: 1;
  committed: true;
  revision: string;
  progress: ArchiveFileProgress;
  admitted: number;
  confirmedDead: 0;
}
export interface ArchiveProgressQuery {
  schemaVersion: 1;
  query: string;
  year: number | null;
  decade?: ArchiveDecade | null;
}
export interface ArchiveFavoriteRequest {
  schemaVersion: 1;
  titleRef: string;
  expectedRevision: string;
  value: boolean;
}
export interface ArchiveFavoriteReceipt {
  schemaVersion: 1;
  committed: true;
  revision: string;
  titleRef: string;
  favorite: boolean;
}
export type ArchiveRemovalTarget =
  | { kind: 'title'; titleRef: string }
  | { kind: 'file'; titleRef: string; fileRef: string }
  | { kind: 'library' };
export interface ArchiveRemovalRequest {
  schemaVersion: 1;
  expectedRevision: string;
  explicitAction: true;
}
export interface ArchiveRemovalReceipt {
  schemaVersion: 1;
  committed: true;
  revision: string;
  removedTitles: number;
  removedFiles: number;
  removedFavorites: number;
  clearedProgress: number;
  cleanupPending: boolean;
}
export function validateArchiveRemovalReceipt(
  value: unknown,
  expectedRevision: string,
  clear = false,
): ArchiveRemovalReceipt {
  const r = record(value, [
    'schemaVersion',
    'committed',
    'revision',
    'removedTitles',
    'removedFiles',
    'removedFavorites',
    'clearedProgress',
    'cleanupPending',
  ]);
  if (
    !archiveRevision(expectedRevision) ||
    r.schemaVersion !== 1 ||
    r.committed !== true ||
    !archiveRevision(r.revision) ||
    !integer(r.removedTitles, 1400) ||
    !integer(r.removedFiles, 1400000) ||
    !integer(r.removedFavorites, 10000) ||
    !integer(r.clearedProgress, 1441) ||
    typeof r.cleanupPending !== 'boolean' ||
    BigInt(r.revision) < BigInt(expectedRevision) ||
    BigInt(r.revision) > BigInt(expectedRevision) + 1n ||
    (clear && BigInt(r.revision) !== BigInt(expectedRevision) + 1n) ||
    (r.revision === expectedRevision &&
      (r.removedTitles !== 0 ||
        r.removedFiles !== 0 ||
        r.removedFavorites !== 0 ||
        r.clearedProgress !== 0))
  )
    throw invalid();
  bounded(r);
  return { ...r } as unknown as ArchiveRemovalReceipt;
}
export interface ArchiveProgress {
  schemaVersion: 1;
  revision: string;
  year: number | null;
  nextPage: number;
  complete: boolean;
  capacityReached: boolean;
  /** Absolute epoch-millisecond retry deadline, not a duration. */
  retryAfterMs: number | null;
  titleCount: number;
}
export interface ArchiveSelection {
  /** Present together only for an app-managed local copy; never an upstream path/URL. */
  downloadRef?: string;
  downloadRevision?: string;
  titleRef: string;
  fileRef: string;
  expectedRevision: string;
  title: string;
  fileTitle: string;
}
const invalid = () => new Error('The Archive catalog request or response is invalid.');
const sourceFailures = new WeakSet<object>();
class ArchiveDiscoverySourceFailure extends Error {
  constructor() {
    super('An archive source could not be checked. Saved matches remain available.');
    sourceFailures.add(this);
  }
}
export function isArchiveDiscoverySourceFailure(error: unknown): boolean {
  return error instanceof ArchiveDiscoverySourceFailure && sourceFailures.has(error);
}
function rejectDiscoveryFailure(error: unknown): never {
  if (
    typeof error === 'string' &&
    [
      'archive-network-unavailable',
      'archive-server-unavailable',
      'archive-rate-limited',
      'archive-request-timeout',
      'archive-dns-unavailable',
    ].includes(error)
  )
    throw new ArchiveDiscoverySourceFailure();
  // Unknown failures remain a hard failure; never expose raw upstream errors.
  throw new Error('Archive discovery could not finish.');
}
const LIMIT = 1024 * 1024;
function record(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const row = value as Record<string, unknown>;
  if (
    keys.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !keys.includes(key) && !optional.includes(key))
  )
    throw invalid();
  return row;
}
export function archiveRevision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9][0-9]{0,18})$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function opaque(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
function text(value: unknown, limit = 16384, empty = false): value is string {
  return (
    boundedUtf8Text(value, limit, empty) && !/[\p{Cc}\p{Cf}]/u.test(value) && !value.includes('://')
  );
}
function integer(value: unknown, max: number, min = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
function decade(value: unknown): value is ArchiveDecade | null | undefined {
  return value == null || [1960, 1970, 1980, 1990, 2000, 2010, 2020].includes(value as number);
}
function languageMode(value: unknown): value is ArchiveLanguageMode | undefined {
  return (
    value === undefined ||
    (typeof value === 'string' && ['all', 'english-first', 'english', 'unlisted'].includes(value))
  );
}
function contentType(value: unknown): value is ArchiveContentType | 'all' | undefined {
  return (
    value === undefined ||
    (typeof value === 'string' && ['all', 'tv', 'movie', 'short', 'unknown'].includes(value))
  );
}
function artworkProof(value: unknown): ArchiveArtworkProof {
  const r = record(value, [
    'schemaVersion',
    'artworkRef',
    'itemId',
    'fileName',
    'sizeBytes',
    'mimeType',
    'provenance',
  ]);
  if (
    r.schemaVersion !== 1 ||
    !opaque(r.artworkRef) ||
    typeof r.itemId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(r.itemId) ||
    !(
      (r.fileName === '__ia_thumb.jpg' && r.mimeType === 'image/jpeg') ||
      (r.fileName === '__ia_thumb.png' && r.mimeType === 'image/png')
    ) ||
    typeof r.sizeBytes !== 'string' ||
    !/^[1-9][0-9]{0,5}$/u.test(r.sizeBytes) ||
    BigInt(r.sizeBytes) > 524288n ||
    r.provenance !== 'provider-item'
  )
    throw invalid();
  return { ...r } as unknown as ArchiveArtworkProof;
}
function artworkRequest(value: ArchiveArtworkRequest): ArchiveArtworkRequest {
  const r = record(value, ['schemaVersion', 'titleRef', 'expectedRevision']);
  if (r.schemaVersion !== 1 || !opaque(r.titleRef) || !archiveRevision(r.expectedRevision))
    throw invalid();
  return { ...r } as unknown as ArchiveArtworkRequest;
}
export function validateArchiveArtworkResponse(
  value: unknown,
  request: ArchiveArtworkRequest,
): ArchiveArtworkResponse | null {
  const q = artworkRequest(request);
  if (value === null) return null;
  const r = record(value, [
    'schemaVersion',
    'titleRef',
    'revision',
    'artworkRef',
    'mimeType',
    'width',
    'height',
    'byteLength',
    'dataUrl',
  ]);
  if (
    r.schemaVersion !== 1 ||
    r.titleRef !== q.titleRef ||
    r.revision !== q.expectedRevision ||
    !opaque(r.artworkRef) ||
    !['image/jpeg', 'image/png'].includes(r.mimeType as string) ||
    !integer(r.width, 2048, 1) ||
    !integer(r.height, 2048, 1) ||
    r.width * r.height > 1048576 ||
    !integer(r.byteLength, 524288, 1) ||
    typeof r.dataUrl !== 'string' ||
    !r.dataUrl.startsWith(`data:${r.mimeType};base64,`)
  )
    throw invalid();
  const encoded = r.dataUrl.slice(`data:${r.mimeType};base64,`.length);
  if (
    encoded.length > 699052 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  )
    throw invalid();
  try {
    if (atob(encoded).length !== r.byteLength) throw invalid();
  } catch {
    throw invalid();
  }
  return { ...r } as unknown as ArchiveArtworkResponse;
}
function duration(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 604800)
  );
}
function bounded(value: unknown): void {
  if (!boundedUtf8Text(JSON.stringify(value), LIMIT)) throw invalid();
}
export function validateArchiveTitle(value: unknown): ArchiveTitle {
  const r = record(
    value,
    [
      'favorite',
      'titleRef',
      'title',
      'kind',
      'releaseYear',
      'curated',
      'titleProvenance',
      'fileCount',
      'durationSeconds',
      'rights',
      'rank',
      'quality',
      'observedMs',
    ],
    [
      'providerLanguages',
      'languageProvenance',
      'providerSubjects',
      'providerDescription',
      'matchBasis',
      'contentType',
      'contentTypeProvenance',
      'providerSeries',
      'artwork',
      'providerId',
      'sourceUrl',
      'dateAssessment',
    ],
  );
  if (
    (r.providerId === undefined) !== (r.sourceUrl === undefined) ||
    (r.providerId !== undefined &&
      (!publicArchiveProvider(r.providerId) || !publicArchiveSource(r.sourceUrl, r.providerId))) ||
    (r.contentType !== undefined && (!contentType(r.contentType) || r.contentType === 'all')) ||
    (r.contentType === undefined) !== (r.contentTypeProvenance === undefined) ||
    (r.contentTypeProvenance !== undefined &&
      r.contentTypeProvenance !== (r.contentType === 'unknown' ? 'unknown' : 'provider-item')) ||
    (r.providerSeries !== undefined && r.providerSeries !== null && !text(r.providerSeries, 512)) ||
    typeof r.favorite !== 'boolean' ||
    !opaque(r.titleRef) ||
    !text(r.title, 512) ||
    !['tv', 'movie'].includes(r.kind as string) ||
    !(r.releaseYear === null || integer(r.releaseYear, 2100, 1888)) ||
    typeof r.curated !== 'boolean' ||
    (r.curated && !integer(r.releaseYear, 1999, 1960)) ||
    r.titleProvenance !== 'provider-item' ||
    !integer(r.fileCount, 1000, 1) ||
    !duration(r.durationSeconds) ||
    (r.rights !== null &&
      !(r.providerId ? providerPlainText(r.rights, 4096) : text(r.rights, 2048))) ||
    !integer(r.rank, 1400, r.providerId ? 0 : 1) ||
    (r.providerId !== undefined && r.curated !== false) ||
    r.quality !== (r.providerId ? 'metadata-listed' : 'metadata-h264') ||
    !integer(r.observedMs, Number.MAX_SAFE_INTEGER) ||
    (r.providerLanguages !== undefined &&
      (!Array.isArray(r.providerLanguages) ||
        r.providerLanguages.length > (r.providerId ? 32 : 16) ||
        r.providerLanguages.some(
          (v) => !(r.providerId ? providerPlainText(v, 256) : text(v, 128)),
        ))) ||
    (r.providerSubjects !== undefined &&
      (!Array.isArray(r.providerSubjects) ||
        r.providerSubjects.length > (r.providerId ? 32 : 16) ||
        r.providerSubjects.some(
          (v) => !(r.providerId ? providerPlainText(v, 256) : text(v, 128)),
        ))) ||
    (r.languageProvenance !== undefined &&
      !['provider-item', 'unknown'].includes(r.languageProvenance as string)) ||
    (r.providerDescription !== undefined &&
      r.providerDescription !== null &&
      !(r.providerId
        ? providerPlainText(r.providerDescription, 4096)
        : text(r.providerDescription, 2048))) ||
    (r.matchBasis !== undefined &&
      !['title', 'series', 'subject', 'genre', 'file', 'legacy-metadata', 'browse'].includes(
        r.matchBasis as string,
      )) ||
    (r.languageProvenance === 'provider-item' &&
      (!Array.isArray(r.providerLanguages) || !r.providerLanguages.length)) ||
    (r.languageProvenance === 'unknown' &&
      Array.isArray(r.providerLanguages) &&
      r.providerLanguages.length > 0)
  )
    throw invalid();
  const dateAssessment =
    r.dateAssessment === undefined ? undefined : validateDateAssessment(r.dateAssessment, r);
  return {
    ...r,
    ...(dateAssessment === undefined ? {} : { dateAssessment }),
    ...(r.artwork == null ? {} : { artwork: artworkProof(r.artwork) }),
  } as unknown as ArchiveTitle;
}
function validateDateAssessment(
  value: unknown,
  title: Record<string, unknown>,
): ArchiveDateAssessment {
  const keys = [
    'version',
    'providerListedYear',
    'originalReleaseYear',
    'status',
    'provenance',
    'field',
  ];
  const r = record(value, keys);
  if (
    title.providerId !== undefined ||
    Reflect.ownKeys(r).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(r, key) ?? {}, 'value'))
  )
    throw invalid();
  if (
    r.version !== 1 ||
    r.providerListedYear !== title.releaseYear ||
    !(r.providerListedYear === null || integer(r.providerListedYear, 2100, 1888)) ||
    r.originalReleaseYear !== null ||
    r.status !== (r.providerListedYear === null ? 'unknown' : 'unverified-item-date') ||
    r.provenance !== 'legacy-item-year' ||
    r.field !== 'unknown'
  )
    throw invalid();
  return { ...r } as unknown as ArchiveDateAssessment;
}
export function validateArchiveFile(value: unknown): ArchiveFile {
  const r = record(
    value,
    [
      'fileRef',
      'title',
      'fileName',
      'itemId',
      'format',
      'durationSeconds',
      'sizeBytes',
      'availability',
      'observedMs',
    ],
    ['providerFacts'],
  );
  const facts =
    r.providerFacts === undefined ? undefined : validateArchiveProviderFacts(r.providerFacts);
  const publicItem =
    facts &&
    typeof r.itemId === 'string' &&
    (facts.providerId === 'commons'
      ? /^[1-9][0-9]{0,19}$/u.test(r.itemId)
      : facts.providerId === 'loc'
        ? /^[A-Za-z0-9._-]{1,256}$/u.test(r.itemId)
        : publicArchiveNasaItemId(r.itemId));
  const size =
    r.sizeBytes === null
      ? !!facts
      : typeof r.sizeBytes === 'string' &&
        /^[1-9][0-9]{0,18}$/u.test(r.sizeBytes) &&
        BigInt(r.sizeBytes) <= 68719476736n;
  if (
    !opaque(r.fileRef) ||
    !(facts ? providerPlainText(r.title, 512) : text(r.title, 512)) ||
    !(facts ? providerPlainText(r.fileName, 1024) : text(r.fileName, 1024)) ||
    typeof r.itemId !== 'string' ||
    !(facts ? publicItem : /^[A-Za-z0-9._-]{1,100}$/u.test(r.itemId)) ||
    !(facts ? providerPlainText(r.format, 128) : r.format === 'h.264') ||
    !duration(r.durationSeconds) ||
    !size ||
    !['unverified', 'reachable', 'played', 'dead'].includes(r.availability as string) ||
    !integer(r.observedMs, Number.MAX_SAFE_INTEGER)
  )
    throw invalid();
  return { ...r, ...(facts ? { providerFacts: facts } : {}) } as unknown as ArchiveFile;
}
export function validateArchiveQuery(value: ArchiveQuery): ArchiveQuery {
  const r = record(
    value,
    ['schemaVersion', 'query', 'expectedRevision', 'offset', 'pageSize'],
    ['curatedOnly', 'decade', 'favoritesOnly', 'languageMode', 'contentType'],
  );
  if (
    r.schemaVersion !== 1 ||
    !text(r.query, 256, true) ||
    !(archiveRevision(r.expectedRevision) || (r.expectedRevision === null && r.offset === 0)) ||
    !integer(r.offset, r.curatedOnly ? 400 : 1400) ||
    !integer(r.pageSize, 50, 1) ||
    (r.curatedOnly !== undefined && typeof r.curatedOnly !== 'boolean') ||
    !decade(r.decade) ||
    (r.favoritesOnly !== undefined && typeof r.favoritesOnly !== 'boolean') ||
    !languageMode(r.languageMode) ||
    !contentType(r.contentType)
  )
    throw invalid();
  return { ...r } as unknown as ArchiveQuery;
}
export function validateArchiveFilesQuery(value: ArchiveFilesQuery): ArchiveFilesQuery {
  const r = record(value, ['schemaVersion', 'titleRef', 'expectedRevision', 'offset', 'pageSize']);
  if (
    r.schemaVersion !== 1 ||
    !opaque(r.titleRef) ||
    !archiveRevision(r.expectedRevision) ||
    !integer(r.offset, 1000) ||
    !integer(r.pageSize, 50, 1)
  )
    throw invalid();
  return { ...r } as unknown as ArchiveFilesQuery;
}
function pageShape(
  r: Record<string, unknown>,
  expected: { expectedRevision: string | null; offset: number; pageSize: number },
  values: unknown,
  max: number,
): asserts values is unknown[] {
  if (
    r.schemaVersion !== 1 ||
    !archiveRevision(r.revision) ||
    (expected.expectedRevision !== null && r.revision !== expected.expectedRevision) ||
    r.offset !== expected.offset ||
    !integer(r.totalCount, max) ||
    !Array.isArray(values) ||
    values.length > expected.pageSize ||
    values.length > Math.max(0, (r.totalCount as number) - expected.offset) ||
    (expected.offset < (r.totalCount as number) && values.length === 0) ||
    typeof r.more !== 'boolean' ||
    r.more !== expected.offset + values.length < (r.totalCount as number)
  )
    throw invalid();
  bounded(r);
}
export function validateArchivePage(value: unknown, expected: ArchiveQuery): ArchivePage {
  const q = validateArchiveQuery(expected),
    r = record(value, ['schemaVersion', 'revision', 'totalCount', 'offset', 'items', 'more']);
  pageShape(r, q, r.items, q.curatedOnly ? 400 : 1400);
  const identities = new Set<string>(),
    yearRanks = new Set<string>();
  const items = r.items.map((value) => {
    const item = validateArchiveTitle(value);
    const rank = `${item.releaseYear}:${item.rank}`;
    if (
      identities.has(item.titleRef) ||
      (q.contentType !== undefined &&
        q.contentType !== 'all' &&
        (item.contentType ?? 'unknown') !== q.contentType) ||
      (q.favoritesOnly && !item.favorite) ||
      (q.decade != null &&
        (item.releaseYear === null ||
          item.releaseYear < q.decade ||
          item.releaseYear > decadeEnd(q.decade))) ||
      (item.curated && yearRanks.has(rank)) ||
      (q.curatedOnly && (!item.curated || item.rank > 10))
    )
      throw invalid();
    identities.add(item.titleRef);
    if (item.curated) yearRanks.add(rank);
    return item;
  });
  return { ...r, items } as unknown as ArchivePage;
}
export function validateArchiveFilesPage(
  value: unknown,
  expected: ArchiveFilesQuery,
): ArchiveFilesPage {
  const q = validateArchiveFilesQuery(expected),
    r = record(value, [
      'schemaVersion',
      'revision',
      'titleRef',
      'totalCount',
      'offset',
      'files',
      'more',
    ]);
  if (r.titleRef !== q.titleRef) throw invalid();
  pageShape(r, q, r.files, 1000);
  const refs = new Set<string>(),
    identities = new Set<string>();
  const files = r.files.map((value) => {
    const file = validateArchiveFile(value);
    const id = JSON.stringify([file.itemId, file.fileName]);
    if (refs.has(file.fileRef) || (!file.providerFacts && identities.has(id))) throw invalid();
    refs.add(file.fileRef);
    if (!file.providerFacts) identities.add(id);
    return file;
  });
  return { ...r, files } as unknown as ArchiveFilesPage;
}
export function validateArchiveDiscoveryView(value: ArchiveDiscoveryView): ArchiveDiscoveryView {
  const r = record(
    value,
    ['schemaVersion', 'languageMode', 'favoritesOnly', 'curatedOnly'],
    ['contentType'],
  );
  if (
    r.schemaVersion !== 1 ||
    r.languageMode === undefined ||
    !languageMode(r.languageMode) ||
    typeof r.favoritesOnly !== 'boolean' ||
    typeof r.curatedOnly !== 'boolean' ||
    !contentType(r.contentType)
  )
    throw invalid();
  return { ...r } as unknown as ArchiveDiscoveryView;
}
function stepQuery(value: ArchiveDiscoverStep): ArchiveDiscoverStep {
  const r = record(
    value,
    ['schemaVersion', 'expectedRevision', 'year', 'page', 'query', 'explicitAction'],
    ['restart', 'decade', 'view'],
  );
  if (
    r.schemaVersion !== 1 ||
    !archiveRevision(r.expectedRevision) ||
    !(r.year === null || integer(r.year, 1999, 1960)) ||
    !integer(r.page, 20, 1) ||
    !text(r.query, 256, true) ||
    (r.year === null && !(r.query as string).trim()) ||
    r.explicitAction !== true ||
    (r.restart !== undefined && typeof r.restart !== 'boolean') ||
    (r.restart === true && r.page !== 1) ||
    !decade(r.decade) ||
    (r.year !== null &&
      r.decade != null &&
      ((r.year as number) < r.decade || (r.year as number) > r.decade + 9))
  )
    throw invalid();
  return {
    ...r,
    ...(r.view === undefined
      ? {}
      : { view: validateArchiveDiscoveryView(r.view as ArchiveDiscoveryView) }),
  } as unknown as ArchiveDiscoverStep;
}
export function validateArchiveDiscoverReceipt(
  value: unknown,
  request: ArchiveDiscoverStep,
): ArchiveDiscoverReceipt {
  const q = stepQuery(request),
    r = record(
      value,
      [
        'schemaVersion',
        'committed',
        'revision',
        'year',
        'page',
        'nextPage',
        'examined',
        'admitted',
        'excludedUnknownYear',
        'unavailable',
        'titleCount',
        'confirmedDead',
        'transientFailures',
        'capacityReached',
        'retryAfterMs',
        'rankingPolicy',
        'pendingFilePages',
      ],
      ['newVisibleMatches'],
    );
  if (
    r.schemaVersion !== 1 ||
    r.committed !== true ||
    !archiveRevision(r.revision) ||
    BigInt(r.revision) < BigInt(q.expectedRevision) ||
    r.year !== q.year ||
    r.page !== q.page ||
    !(
      r.nextPage === null ||
      (integer(r.nextPage, 20, 1) &&
        (r.nextPage === q.page + 1 ||
          (r.nextPage === q.page && integer(r.retryAfterMs, Number.MAX_SAFE_INTEGER, 1))))
    ) ||
    !integer(r.examined, q.view === undefined ? 1000 : 20) ||
    !integer(r.admitted, 20) ||
    !integer(r.excludedUnknownYear, 1000) ||
    !integer(r.unavailable, 1000) ||
    !integer(r.titleCount, 1400) ||
    !integer(r.confirmedDead, 1000) ||
    !integer(r.transientFailures, 1000) ||
    typeof r.capacityReached !== 'boolean' ||
    !(r.retryAfterMs === null || integer(r.retryAfterMs, Number.MAX_SAFE_INTEGER, 1)) ||
    r.rankingPolicy !== 'archive-popularity-playable-v1' ||
    (q.view === undefined
      ? r.newVisibleMatches !== undefined
      : !integer(r.newVisibleMatches, 20) || BigInt(r.revision) !== BigInt(q.expectedRevision) + 1n)
  )
    throw invalid();
  if (!Array.isArray(r.pendingFilePages) || r.pendingFilePages.length > 20) throw invalid();
  const pendingFilePages = r.pendingFilePages.map(validateArchiveFileProgress);
  if (
    new Set(pendingFilePages.map((item) => item.titleRef)).size !== pendingFilePages.length ||
    pendingFilePages.some((item) => item.complete)
  )
    throw invalid();
  bounded(r);
  return { ...r, pendingFilePages } as unknown as ArchiveDiscoverReceipt;
}
function progressQuery(value: ArchiveProgressQuery): ArchiveProgressQuery {
  const r = record(value, ['schemaVersion', 'query', 'year'], ['decade']);
  if (
    r.schemaVersion !== 1 ||
    !text(r.query, 256, true) ||
    !(r.year === null || integer(r.year, 1999, 1960)) ||
    (r.year === null && !(r.query as string).trim()) ||
    !decade(r.decade) ||
    (r.year !== null &&
      r.decade != null &&
      ((r.year as number) < r.decade || (r.year as number) > r.decade + 9))
  )
    throw invalid();
  return { ...r } as unknown as ArchiveProgressQuery;
}
export function validateArchiveProgress(
  value: unknown,
  request: ArchiveProgressQuery,
): ArchiveProgress {
  const q = progressQuery(request),
    r = record(value, [
      'schemaVersion',
      'revision',
      'year',
      'nextPage',
      'complete',
      'capacityReached',
      'retryAfterMs',
      'titleCount',
    ]);
  if (
    r.schemaVersion !== 1 ||
    !archiveRevision(r.revision) ||
    r.year !== q.year ||
    !integer(r.nextPage, 21, 1) ||
    typeof r.complete !== 'boolean' ||
    typeof r.capacityReached !== 'boolean' ||
    !(r.retryAfterMs === null || integer(r.retryAfterMs, Number.MAX_SAFE_INTEGER, 1)) ||
    !integer(r.titleCount, 1400)
  )
    throw invalid();
  bounded(r);
  return { ...r } as unknown as ArchiveProgress;
}
export function validateArchiveFileProgress(value: unknown): ArchiveFileProgress {
  const r = record(value, [
    'titleRef',
    'title',
    'kind',
    'originalYear',
    'providerFileCount',
    'nextOffset',
    'availableFileCount',
    'complete',
    'capacityReached',
  ]);
  if (
    !opaque(r.titleRef) ||
    !text(r.title, 512) ||
    !['tv', 'movie'].includes(r.kind as string) ||
    !(r.originalYear === null || integer(r.originalYear, 2100, 1888)) ||
    !integer(r.providerFileCount, 100000, 1) ||
    !integer(r.nextOffset, r.providerFileCount as number) ||
    !integer(r.availableFileCount, 1000) ||
    typeof r.complete !== 'boolean' ||
    typeof r.capacityReached !== 'boolean' ||
    r.complete !== (r.nextOffset === r.providerFileCount) ||
    (r.capacityReached && (r.complete || r.nextOffset === r.providerFileCount))
  )
    throw invalid();
  return { ...r } as unknown as ArchiveFileProgress;
}
function fileProgressQuery(value: ArchiveFileProgressQuery): ArchiveFileProgressQuery {
  const r = record(
    value,
    ['schemaVersion', 'expectedRevision', 'offset', 'pageSize'],
    ['query', 'decade', 'favoritesOnly', 'languageMode', 'contentType'],
  );
  if (
    r.schemaVersion !== 1 ||
    !(archiveRevision(r.expectedRevision) || (r.expectedRevision === null && r.offset === 0)) ||
    !integer(r.offset, 1400) ||
    !integer(r.pageSize, 50, 1) ||
    (r.query !== undefined && !text(r.query, 256, true)) ||
    !decade(r.decade) ||
    (r.favoritesOnly !== undefined && typeof r.favoritesOnly !== 'boolean') ||
    !languageMode(r.languageMode) ||
    !contentType(r.contentType)
  )
    throw invalid();
  return { ...r } as unknown as ArchiveFileProgressQuery;
}
function validateFileProgressPage(
  value: unknown,
  q: ArchiveFileProgressQuery,
): ArchiveFileProgressPage {
  const r = record(value, ['schemaVersion', 'revision', 'totalCount', 'offset', 'items', 'more']);
  pageShape(r, q, r.items, 1400);
  const items = (r.items as unknown[]).map(validateArchiveFileProgress);
  if (
    new Set(items.map((item) => item.titleRef)).size !== items.length ||
    items.some(
      (item) =>
        q.decade != null &&
        (item.originalYear === null ||
          item.originalYear < q.decade ||
          item.originalYear > decadeEnd(q.decade)),
    )
  )
    throw invalid();
  bounded(r);
  return { ...r, items } as unknown as ArchiveFileProgressPage;
}
function itemStepQuery(value: ArchiveItemFilesStep): ArchiveItemFilesStep {
  const r = record(
    value,
    ['schemaVersion', 'titleRef', 'expectedRevision', 'expectedOffset', 'explicitAction'],
    ['restart'],
  );
  if (
    r.schemaVersion !== 1 ||
    !opaque(r.titleRef) ||
    !archiveRevision(r.expectedRevision) ||
    !integer(r.expectedOffset, 100000) ||
    r.explicitAction !== true ||
    (r.restart !== undefined && typeof r.restart !== 'boolean')
  )
    throw invalid();
  return { ...r } as unknown as ArchiveItemFilesStep;
}
export function validateArchiveItemFilesReceipt(
  value: unknown,
  q: ArchiveItemFilesStep,
): ArchiveItemFilesReceipt {
  const r = record(value, [
    'schemaVersion',
    'committed',
    'revision',
    'progress',
    'admitted',
    'confirmedDead',
  ]);
  const progress = validateArchiveFileProgress(r.progress);
  if (
    r.schemaVersion !== 1 ||
    r.committed !== true ||
    !archiveRevision(r.revision) ||
    BigInt(r.revision) !== BigInt(q.expectedRevision) + 1n ||
    progress.titleRef !== q.titleRef ||
    !integer(r.admitted, 64) ||
    r.confirmedDead !== 0 ||
    (!q.restart &&
      (progress.nextOffset < q.expectedOffset ||
        (progress.nextOffset === q.expectedOffset && !progress.capacityReached) ||
        progress.nextOffset > q.expectedOffset + 64)) ||
    (q.restart && progress.nextOffset > 64)
  )
    throw invalid();
  bounded(r);
  return { ...r, progress } as unknown as ArchiveItemFilesReceipt;
}
export function createArchiveCatalog(runtime?: OwnedNativeRuntime) {
  const native: OwnedNativeRuntime = runtime ?? {
    invoke: (command: string, args?: Record<string, unknown>) =>
      isTauri()
        ? invoke(command, args)
        : Promise.reject(new Error('Archive browsing requires the installed application.')),
  };
  // Archive commands keep identity inside their strict request DTO; cancellation uses the same exact identity.
  const nested: OwnedNativeRuntime = {
    idFactory: native.idFactory,
    invoke: (command, args) =>
      command === 'cancel_playlist'
        ? native.invoke(command, args)
        : native.invoke(command, {
            request: { ...(args?.request as Record<string, unknown>), requestId: args?.requestId },
          }),
  };
  return {
    publicDiscoverStep(
      request: PublicArchiveDiscoverRequest,
      signal?: AbortSignal,
    ): Promise<PublicArchiveDiscoverReceipt> {
      const admitted = validatePublicArchiveDiscoverRequest(request);
      return invokeOwnedNative(
        nested,
        'public_archive_discover_step',
        { request: admitted },
        {
          signal,
          durable: true,
          validate: (value) => validatePublicArchiveDiscoverReceipt(value, admitted),
        },
      );
    },
    remove(
      target: ArchiveRemovalTarget,
      request: ArchiveRemovalRequest,
      signal?: AbortSignal,
    ): Promise<ArchiveRemovalReceipt> {
      const r = record(request, ['schemaVersion', 'expectedRevision', 'explicitAction']);
      const t = record(
        target,
        target.kind === 'library'
          ? ['kind']
          : target.kind === 'file'
            ? ['kind', 'titleRef', 'fileRef']
            : ['kind', 'titleRef'],
      );
      if (
        r.schemaVersion !== 1 ||
        !archiveRevision(r.expectedRevision) ||
        r.explicitAction !== true ||
        !['library', 'title', 'file'].includes(String(t.kind)) ||
        (t.kind !== 'library' && !opaque(t.titleRef)) ||
        (t.kind === 'file' && !opaque(t.fileRef))
      )
        throw invalid();
      const { kind, ...identity } = t;
      return invokeOwnedNative(
        nested,
        kind === 'library'
          ? 'archive_clear_library'
          : kind === 'title'
            ? 'archive_remove_title'
            : 'archive_remove_file',
        { request: { ...r, ...identity } },
        {
          signal,
          durable: true,
          validate: (value) =>
            validateArchiveRemovalReceipt(value, r.expectedRevision as string, kind === 'library'),
        },
      );
    },
    itemFilesProgress(
      request: ArchiveFileProgressQuery,
      signal?: AbortSignal,
    ): Promise<ArchiveFileProgressPage> {
      const admitted = fileProgressQuery(request);
      return invokeOwnedNative(
        nested,
        'archive_item_files_progress',
        { request: admitted },
        { signal, validate: (value) => validateFileProgressPage(value, admitted) },
      );
    },
    itemFilesStep(
      request: ArchiveItemFilesStep,
      signal?: AbortSignal,
    ): Promise<ArchiveItemFilesReceipt> {
      const admitted = itemStepQuery(request);
      return invokeOwnedNative(
        nested,
        'archive_item_files_step',
        { request: admitted },
        {
          signal,
          durable: true,
          validate: (value) => validateArchiveItemFilesReceipt(value, admitted),
        },
      );
    },
    setFavorite(
      request: ArchiveFavoriteRequest,
      signal?: AbortSignal,
    ): Promise<ArchiveFavoriteReceipt> {
      const row = record(request, ['schemaVersion', 'titleRef', 'expectedRevision', 'value']);
      if (
        row.schemaVersion !== 1 ||
        !opaque(row.titleRef) ||
        !archiveRevision(row.expectedRevision) ||
        typeof row.value !== 'boolean'
      )
        throw invalid();
      const admitted = { ...row } as unknown as ArchiveFavoriteRequest;
      return invokeOwnedNative(
        nested,
        'archive_set_favorite',
        { request: admitted },
        {
          signal,
          durable: true,
          validate: (value) => {
            const result = record(value, [
              'schemaVersion',
              'committed',
              'revision',
              'titleRef',
              'favorite',
            ]);
            if (
              result.schemaVersion !== 1 ||
              result.committed !== true ||
              result.titleRef !== admitted.titleRef ||
              result.favorite !== admitted.value ||
              !archiveRevision(result.revision) ||
              BigInt(result.revision) < BigInt(admitted.expectedRevision) ||
              BigInt(result.revision) > BigInt(admitted.expectedRevision) + 1n
            )
              throw invalid();
            return { ...result } as unknown as ArchiveFavoriteReceipt;
          },
        },
      );
    },
    progress(request: ArchiveProgressQuery, signal?: AbortSignal): Promise<ArchiveProgress> {
      const admitted = progressQuery(request);
      return invokeOwnedNative(
        nested,
        'archive_discovery_progress',
        { request: admitted },
        { signal, validate: (value) => validateArchiveProgress(value, admitted) },
      );
    },
    query(request: ArchiveQuery, signal?: AbortSignal): Promise<ArchivePage> {
      const admitted = validateArchiveQuery(request);
      return invokeOwnedNative(
        nested,
        'archive_query_catalog',
        { request: admitted },
        { signal, validate: (value) => validateArchivePage(value, admitted) },
      );
    },
    files(request: ArchiveFilesQuery, signal?: AbortSignal): Promise<ArchiveFilesPage> {
      const admitted = validateArchiveFilesQuery(request);
      return invokeOwnedNative(
        nested,
        'archive_title_files',
        { request: admitted },
        { signal, validate: (value) => validateArchiveFilesPage(value, admitted) },
      );
    },
    artwork(
      request: ArchiveArtworkRequest,
      signal?: AbortSignal,
    ): Promise<ArchiveArtworkResponse | null> {
      const admitted = artworkRequest(request);
      return invokeOwnedNative(
        nested,
        'archive_title_artwork',
        { request: admitted },
        { signal, validate: (value) => validateArchiveArtworkResponse(value, admitted) },
      );
    },
    discoverStep(
      request: ArchiveDiscoverStep,
      signal?: AbortSignal,
    ): Promise<ArchiveDiscoverReceipt> {
      const admitted = stepQuery(request);
      return invokeOwnedNative(
        nested,
        'archive_discover_step',
        { request: admitted },
        {
          signal,
          durable: true,
          validate: (value) => validateArchiveDiscoverReceipt(value, admitted),
          failure: rejectDiscoveryFailure,
        },
      );
    },
  };
}
