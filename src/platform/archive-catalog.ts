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

import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';
import {
  validatePublicArchiveDiscoverRequest,
  validatePublicArchiveDiscoverReceipt,
  type PublicArchiveDiscoverRequest,
  type PublicArchiveDiscoverReceipt,
} from './archive-public-providers';
import {
  type ArchiveRemovalReceipt,
  type ArchiveArtworkRequest,
  type ArchiveArtworkResponse,
  type ArchiveQuery,
  type ArchiveFilesQuery,
  type ArchivePage,
  type ArchiveFilesPage,
  type ArchiveDiscoverStep,
  type ArchiveDiscoverReceipt,
  type ArchiveProgressQuery,
  type ArchiveProgress,
  type ArchiveFileProgressQuery,
  type ArchiveFileProgressPage,
  type ArchiveItemFilesStep,
  type ArchiveItemFilesReceipt,
  type ArchiveRemovalTarget,
  type ArchiveRemovalRequest,
  type ArchiveFavoriteRequest,
  type ArchiveFavoriteReceipt,
} from './archive-catalog-types';
import {
  record,
  archiveRevision,
  opaque,
  invalid,
  validateArchiveRemovalReceipt,
  fileProgressQuery,
  validateFileProgressPage,
  itemStepQuery,
  validateArchiveItemFilesReceipt,
  progressQuery,
  validateArchiveProgress,
  validateArchiveQuery,
  validateArchivePage,
  validateArchiveFilesQuery,
  validateArchiveFilesPage,
  artworkRequest,
  validateArchiveArtworkResponse,
  stepQuery,
  validateArchiveDiscoverReceipt,
  rejectDiscoveryFailure,
} from './archive-catalog-validation';
export {
  validateArchiveRemovalReceipt,
  isArchiveDiscoverySourceFailure,
  archiveRevision,
  validateArchiveArtworkResponse,
  validateArchiveTitle,
  validateArchiveFile,
  validateArchiveQuery,
  validateArchiveFilesQuery,
  validateArchivePage,
  validateArchiveFilesPage,
  validateArchiveDiscoveryView,
  validateArchiveDiscoverReceipt,
  validateArchiveProgress,
  validateArchiveFileProgress,
  validateArchiveItemFilesReceipt,
} from './archive-catalog-validation';
export {
  type ArchiveDateAssessment,
  type ArchiveTitle,
  type ArchiveFile,
  type ArchiveQuery,
  type ArchiveDecade,
  type ArchiveContentType,
  type ArchiveArtworkProof,
  type ArchiveArtworkRequest,
  type ArchiveArtworkResponse,
  type ArchiveLanguageMode,
  type ArchivePage,
  type ArchiveFilesQuery,
  type ArchiveFilesPage,
  type ArchiveDiscoveryView,
  type ArchiveDiscoverStep,
  type ArchiveDiscoverReceipt,
  type ArchiveFileProgress,
  type ArchiveFileProgressQuery,
  type ArchiveFileProgressPage,
  type ArchiveItemFilesStep,
  type ArchiveItemFilesReceipt,
  type ArchiveProgressQuery,
  type ArchiveFavoriteRequest,
  type ArchiveFavoriteReceipt,
  type ArchiveRemovalTarget,
  type ArchiveRemovalRequest,
  type ArchiveRemovalReceipt,
  type ArchiveProgress,
  type ArchiveSelection,
} from './archive-catalog-types';
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
