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

import type { Source } from './parser';
import type { ProviderGeographyDocuments } from './provider-geography';
import type { SourceSnapshotEntry } from '../discovery/incremental-refresh';

export const PAGED_SOURCE_PAGE_BYTES = 1024 * 1024 - 1024;
export interface PagedParserInput {
  readonly text: string;
  readonly source: Source;
  readonly geography?: { documents: ProviderGeographyDocuments; rawCities?: string };
  readonly warnings?: readonly string[];
}
export interface PagedParserSummary {
  readonly entryCount: number;
  /** Complete warning count; preview omission is explicit, never a success without warnings. */
  readonly warningCount: number;
  readonly warnings: readonly string[];
}
export type PagedParserRequest =
  | { schemaVersion: 1; requestId: number; kind: 'open'; input: PagedParserInput }
  | { schemaVersion: 1; requestId: number; kind: 'next'; expectedIndex: number }
  | { schemaVersion: 1; requestId: number; kind: 'close' };
export type PagedParserResponse =
  | { schemaVersion: 1; requestId: number; kind: 'ready'; summary: PagedParserSummary }
  | { schemaVersion: 1; requestId: number; kind: 'page'; startIndex: number;
      entries: readonly SourceSnapshotEntry[]; exhausted: boolean }
  | { schemaVersion: 1; requestId: number; kind: 'closed' }
  | { schemaVersion: 1; requestId: number; kind: 'error'; code: string; message: string };
