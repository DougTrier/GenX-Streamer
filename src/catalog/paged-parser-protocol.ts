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
