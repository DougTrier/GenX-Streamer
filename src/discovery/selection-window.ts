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

import { validateCatalog, type Source } from '../catalog';
import { validatePreferences } from '../preferences';
import { validateHealthRecords } from '../catalog/health-record';
import { boundedJsonUtf8Bytes, JsonByteLimitError } from '../data-transfer/json-byte-admission';
import { MAX_PLAYLIST_BYTES } from '../catalog/parser';
import { normalizeSourceMime } from '../sources';
import { checkpointRevision } from './scan-checkpoint';
import type { SelectionWindowRequest, PreparedSelectionSessionWindow } from './selection-session';

const refused = () => new Error('Selection window is invalid or exceeds its bounds.');
const sizeErrors = new WeakSet<object>();
class SelectionWindowSizeError extends Error {
  constructor() {
    super('Selection window exceeds its byte bound. Continue with a smaller batch.');
    sizeErrors.add(this);
  }
}
export function isSelectionWindowSizeError(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && sizeErrors.has(error);
}
/** Internal transport reconstruction; never infer this refusal from freeform messages. */
export function selectionWindowSizeRefusal(): Error {
  return new SelectionWindowSizeError();
}
export function admitSelectionWindowBytes(value: unknown): void {
  try {
    boundedJsonUtf8Bytes(value, MAX_PLAYLIST_BYTES);
  } catch (error) {
    if (error instanceof JsonByteLimitError) throw selectionWindowSizeRefusal();
    throw error;
  }
}
export function validateSelectionWindowCounts(input: SelectionWindowRequest): void {
  if (
    !input ||
    input.schemaVersion !== 1 ||
    !Array.isArray(input.chunks) ||
    input.chunks.length < 1 ||
    input.chunks.length > 4
  )
    throw refused();
  checkpointRevision(input.expectedCatalogRevision);
  let total = 0;
  const keys = new Set<string>();
  for (const chunk of input.chunks) {
    if (
      !chunk ||
      !chunk.selection ||
      !Array.isArray(chunk.selection.sources) ||
      chunk.selection.sources.length > 100
    )
      throw refused();
    let count = 0;
    for (const source of chunk.selection.sources) {
      if (!Array.isArray(source.candidates)) throw refused();
      count += source.candidates.length;
      if (count > 64) throw refused();
    }
    total += count;
    if (total > 256) throw refused();
    if (chunk.review) {
      if (
        !Array.isArray(chunk.review.candidates) ||
        !Array.isArray(chunk.review.observations) ||
        chunk.review.candidates.length > 64 ||
        chunk.review.observations.length > 64
      )
        throw refused();
      for (const candidate of chunk.review.candidates) {
        if (keys.has(candidate.key)) throw refused();
        keys.add(candidate.key);
      }
    }
  }
}
export function validateSelectionWindowRequest(input: SelectionWindowRequest): void {
  validateSelectionWindowCounts(input);
  admitSelectionWindowBytes(input);
  validatePreferences(input.preferences);
}
export function validatePreparedSelectionWindow(
  raw: unknown,
  sources: readonly Source[],
): asserts raw is PreparedSelectionSessionWindow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw refused();
  const value = raw as PreparedSelectionSessionWindow;
  if (
    Object.keys(value).sort().join(',') !==
      'chunks,expectedCatalogRevision,nextPreferences,preparationId,schemaVersion,totalSelectionCount' ||
    value.schemaVersion !== 1 ||
    !/^[A-Za-z0-9-]{1,128}$/u.test(value.preparationId) ||
    !Array.isArray(value.chunks) ||
    value.chunks.length < 1 ||
    value.chunks.length > 4 ||
    !Number.isSafeInteger(value.totalSelectionCount) ||
    value.totalSelectionCount < 0 ||
    value.totalSelectionCount > 256
  )
    throw refused();
  checkpointRevision(value.expectedCatalogRevision);
  admitSelectionWindowBytes(value);
  validatePreferences(value.nextPreferences);
  let previous: PreparedSelectionSessionWindow['chunks'][number]['catalogPatch'] | null = null;
  let total = 0;
  for (const chunk of value.chunks) {
    if (Object.keys(chunk).sort().join(',') !== 'catalogPatch,incomingHealth') throw refused();
    const p = chunk.catalogPatch;
    if (
      !p ||
      p.schemaVersion !== 1 ||
      Object.keys(p).sort().join(',') !==
        'baseChannelCount,baseSourceCount,channels,finalChannelCount,finalSourceCount,schemaVersion,sources' ||
      !Array.isArray(p.channels) ||
      p.channels.length > 64 ||
      !Array.isArray(p.sources) ||
      p.sources.length > 100 ||
      p.finalSourceCount > 100 ||
      p.finalChannelCount > 100000 ||
      p.finalSourceCount < p.baseSourceCount ||
      p.finalChannelCount < p.baseChannelCount ||
      ![p.baseSourceCount, p.baseChannelCount, p.finalSourceCount, p.finalChannelCount].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      !Array.isArray(chunk.incomingHealth) ||
      chunk.incomingHealth.length > 64
    )
      throw refused();
    if (
      previous &&
      (p.baseSourceCount !== previous.finalSourceCount ||
        p.baseChannelCount !== previous.finalChannelCount)
    )
      throw refused();
    total += p.channels.length;
    if (total > 256) throw refused();
    validateHealthRecords(chunk.incomingHealth);
    validateCatalog({
      schemaVersion: 1,
      sources: sources.map((source) => ({
        ...source,
        ...(source.mediaMime === undefined
          ? {}
          : { mediaMime: normalizeSourceMime(source.mediaMime) ?? source.mediaMime }),
      })),
      channels: p.channels,
    });
    previous = p;
  }
}
