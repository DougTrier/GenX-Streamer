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

import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';
import { validateCatalog, validateSource, type Channel, type Source } from '../catalog';
import type { BoundedScanAck } from '../application/discovery/bounded-scan-resume';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import { boundedUtf8Text } from './bounded-text';

const failure = () => new Error('Saved scan publication projection is unavailable.');
const decimal = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype)
    throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]),
    )
  )
    throw failure();
  return raw as Record<string, unknown>;
}
const sourceFields = ['id', 'name', 'kind', 'location', 'allowHttp', 'contentKind', 'mediaMime'];
const channelFields = [
  'id',
  'sourceId',
  'providerId',
  'name',
  'category',
  'urls',
  'geography',
  'geographyProvenance',
];
export interface ScanPublicationProjection {
  readonly channels: readonly Channel[];
  readonly sources: readonly Source[];
  readonly wireBytes: number;
}
/** Read only the most recent committed batch, never the complete native catalog/preferences. */
export function createScanPublicationProjectionReader(runtime: OwnedNativeRuntime) {
  return async (
    receipt: BoundedScanAck,
    knownSources: readonly Source[],
    signal: AbortSignal,
  ): Promise<ScanPublicationProjection> => {
    const version = receipt.acknowledgedIndices.length > 64 ? 2 : 1;
    if (receipt.acknowledgedIndices.length > 240) throw failure();
    if (
      !boundedUtf8Text(receipt.planId, 128) ||
      receipt.committed !== true ||
      ![receipt.catalogRevision, receipt.healthRevision, receipt.checkpointRevision].every(
        decimal,
      ) ||
      knownSources.length > 100
    )
      throw failure();
    const capturedSources = knownSources.map((source) => validateSource(source));
    if (new Set(capturedSources.map((source) => source.id)).size !== capturedSources.length)
      throw failure();
    let wireBytes = 0;
    async function pages(kind: 'channels' | 'sources'): Promise<unknown[]> {
      const rows: unknown[] = [];
      let cursor = 0,
        total: number | undefined;
      for (;;) {
        signal.throwIfAborted();
        const page = await invokeOwnedNative(
          runtime,
          'read_scan_resume_publication_projection',
          {
            request: {
              schemaVersion: version,
              planId: receipt.planId,
              catalogRevision: receipt.catalogRevision,
              kind,
              cursor,
              limit: 64,
            },
          },
          {
            signal,
            validate(raw) {
              const p = exact(raw, [
                'schemaVersion',
                'planId',
                'catalogRevision',
                'healthRevision',
                'checkpointRevision',
                'kind',
                'cursor',
                'nextCursor',
                'total',
                'rows',
                'done',
              ]);
              if (
                Object.keys(p).length !== 11 ||
                p.schemaVersion !== version ||
                p.planId !== receipt.planId ||
                p.catalogRevision !== receipt.catalogRevision ||
                p.healthRevision !== receipt.healthRevision ||
                p.checkpointRevision !== receipt.checkpointRevision ||
                p.kind !== kind ||
                p.cursor !== cursor ||
                !Number.isSafeInteger(p.total) ||
                Number(p.total) < 0 ||
                Number(p.total) > (kind === 'channels' ? (version === 2 ? 240 : 64) : 100) ||
                !Array.isArray(p.rows) ||
                p.rows.length > 64 ||
                p.nextCursor !== cursor + p.rows.length ||
                Number(p.nextCursor) > Number(p.total) ||
                p.done !== (p.nextCursor === p.total) ||
                (!p.rows.length && !p.done) ||
                (total !== undefined && total !== p.total)
              )
                throw failure();
              const bytes = boundedJsonUtf8Bytes(raw, 1024 * 1024);
              if (wireBytes + bytes > 20 * 1024 * 1024) throw failure();
              wireBytes += bytes;
              return {
                rows: structuredClone(p.rows) as unknown[],
                nextCursor: Number(p.nextCursor),
                total: Number(p.total),
                done: p.done as boolean,
              };
            },
          },
        );
        total = page.total;
        rows.push(...page.rows);
        cursor = page.nextCursor;
        if (page.done) return rows;
      }
    }
    // Source grants must be available before admitting any returned channel URLs.
    const rawSources = await pages('sources');
    const sources = rawSources.map((raw) => validateSource(exact(raw, sourceFields)));
    if (new Set(sources.map((source) => source.id)).size !== sources.length) throw failure();
    const bySource = new Map(capturedSources.map((source) => [source.id, source]));
    for (const source of sources) bySource.set(source.id, source);
    if (bySource.size > 100) throw failure();
    const rawChannels = await pages('channels');
    for (const row of rawChannels) exact(row, channelFields);
    const channels = validateCatalog({
      schemaVersion: 1,
      sources: [...bySource.values()],
      channels: rawChannels,
    }).channels;
    signal.throwIfAborted();
    return { channels, sources, wireBytes };
  };
}
