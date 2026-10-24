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
 * Which library the channel list shows (live TV or GenXtra) and GenXtra's
 * browsing state: filters, the resume choice, background pause and the
 * counters that keep late results from landing after a switch.
 */
import type { ContentLibrary } from './content-library';
import type {
  ArchiveContentType,
  ArchiveDecade,
  ArchiveSelection,
} from '../platform/archive-catalog';

export interface LibraryState {
  contentLibrary: ContentLibrary;
  libraryIntent: number;
  archiveDecade: ArchiveDecade | null;
  archiveContentType: ArchiveContentType | 'all';
  archiveFavoritesOnly: boolean;
  archiveFilterGeneration: number;
  liveLibraryScroll: number;
  archiveStorageEpoch: number;
  archiveIndexRevision: string | null;
  archiveResumeChoice: ArchiveSelection | null;
  archiveBackgroundPaused: boolean;
  liveBrowseSuspended: boolean;
}

export function createLibraryState(): LibraryState {
  return {
    contentLibrary: 'live',
    libraryIntent: 0,
    archiveDecade: null,
    archiveContentType: 'all',
    archiveFavoritesOnly: false,
    archiveFilterGeneration: 0,
    liveLibraryScroll: 0,
    archiveStorageEpoch: 0,
    archiveIndexRevision: null,
    archiveResumeChoice: null,
    archiveBackgroundPaused: false,
    liveBrowseSuspended: false,
  };
}
