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
 * The GenXtra archive catalog's data types: titles, files, queries, pages,
 * discovery, progress, favorites and removal. Re-exported by archive-catalog.ts.
 */
import { type ArchiveProviderFacts, type PublicArchiveProvider } from './archive-public-providers';

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
