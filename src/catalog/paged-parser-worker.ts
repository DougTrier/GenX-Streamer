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

import { MAX_PLAYLIST_BYTES, parseM3u, PlaylistError, type ChannelCandidate } from './parser';
import { validateCatalog, validateSource } from './codec';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import {
  createProviderGeographyIndex, enrichProviderGeography, prepareProviderGeographyDocuments,
} from './provider-geography';
import {
  PAGED_SOURCE_PAGE_BYTES, type PagedParserRequest, type PagedParserResponse,
} from './paged-parser-protocol';
import type { SourceSnapshotEntry } from '../discovery/incremental-refresh';

/** The complete raw graph belongs only to this worker. Native promotion owns identity/dedup. */
export function createPagedParserOwner() {
  let channels: ChannelCandidate[] | undefined;
  let cursor = 0;
  let closed = false;
  return (request: PagedParserRequest): PagedParserResponse => {
    const envelope = { schemaVersion: 1 as const, requestId: request.requestId };
    try {
      if (request.schemaVersion !== 1 || !Number.isSafeInteger(request.requestId) || request.requestId < 1)
        throw new Error('protocol');
      if (request.kind === 'close') {
        channels = undefined;
        closed = true;
        return { ...envelope, kind: 'closed' };
      }
      if (closed) throw new Error('closed');
      if (request.kind === 'open') {
        if (channels) throw new Error('already-open');
        const source = validateSource(request.input.source);
        const parsed = parseM3u(request.input.text, source.id);
        let index: ReturnType<typeof createProviderGeographyIndex> | undefined;
        if (request.input.geography) {
          const { documents, rawCities } = request.input.geography;
          index = createProviderGeographyIndex(prepareProviderGeographyDocuments(documents, rawCities));
        }
        let retainedBytes = 0;
        for (let i = 0; i < parsed.channels.length; i++) {
          let channel = parsed.channels[i]!;
          if (index) channel = enrichProviderGeography(channel, source, index, {
            allowedSourceLocations: [source.location],
          }).channel;
          // Admit metadata using the existing schema. HTTP syntax does not confer permission.
          const valid = validateCatalog({ schemaVersion: 1, sources: [{ ...source, allowHttp: true }],
            channels: [{ ...channel, id: 'staging-admission' }] }).channels[0]!;
          const { id, ...candidate } = valid;
          void id;
          retainedBytes += boundedJsonUtf8Bytes(candidate, MAX_PLAYLIST_BYTES) + 1;
          if (retainedBytes > MAX_PLAYLIST_BYTES)
            throw new PlaylistError('size', 'Parsed source metadata exceeds the 20 MiB capture limit.');
          parsed.channels[i] = candidate;
        }
        channels = parsed.channels;
        const warnings = [...(request.input.warnings ?? []), ...parsed.warnings];
        const preview: string[] = [];
        let warningBytes = 2;
        for (const warning of warnings) {
          const cost = boundedJsonUtf8Bytes(warning, 16384);
          if (preview.length === 32 || warningBytes + cost + 1 > 16384) break;
          preview.push(warning);
          warningBytes += cost + 1;
        }
        return { ...envelope, kind: 'ready', summary: {
          entryCount: channels.length, warningCount: warnings.length, warnings: preview,
        } };
      }
      if (request.kind !== 'next' || !channels || request.expectedIndex !== cursor)
        throw new Error('cursor');
      const entries: SourceSnapshotEntry[] = [];
      let bytes = 2;
      while (cursor < channels.length && entries.length < 64) {
        const entry = { entryId: `source-raw-${cursor}`, channel: channels[cursor]! };
        const cost = boundedJsonUtf8Bytes(entry, PAGED_SOURCE_PAGE_BYTES);
        if (bytes + cost + (entries.length ? 1 : 0) > PAGED_SOURCE_PAGE_BYTES) break;
        bytes += cost + (entries.length ? 1 : 0);
        entries.push(entry);
        cursor++;
      }
      const startIndex = cursor - entries.length;
      if (!entries.length && cursor < channels.length) throw new Error('page-size');
      return { ...envelope, kind: 'page', startIndex, entries, exhausted: cursor === channels.length };
    } catch (error) {
      channels = undefined;
      closed = true;
      return { ...envelope, kind: 'error',
        code: error instanceof PlaylistError ? error.code : 'admission',
        message: error instanceof PlaylistError ? error.message : 'The source could not be parsed safely. Saved channels were retained.',
      };
    }
  };
}
const owner = createPagedParserOwner();
self.onmessage = (event: MessageEvent<PagedParserRequest>) => {
  self.postMessage(owner(event.data));
};
