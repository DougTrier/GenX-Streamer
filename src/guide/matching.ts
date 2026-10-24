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

import type { Channel } from '../catalog/parser';

export type MappingChannel = Pick<Channel, 'id' | 'sourceId' | 'name' | 'providerId'>;
export interface MappingGuideChannel {
  guideSourceId: string;
  id: string;
  names: readonly string[];
}
export interface MappingCandidate {
  xmltvChannelId: string;
  displayName: string;
}
export interface MappingSuggestion {
  catalogSourceId: string;
  appChannelId: string;
  guideSourceId: string;
  match: 'provider-id' | 'display-name' | 'ambiguous' | 'unmatched';
  candidateCount: number;
  candidatesPreview: MappingCandidate[];
  previewComplete: boolean;
  reviewRequired: true;
}
export interface MappingInput {
  guideSourceId: string;
  catalogChannels: readonly MappingChannel[];
  guideChannels: readonly MappingGuideChannel[];
}
const MAX_RECORDS = 100_000;
const MAX_BYTES = 64 * 1024 * 1024;
const PREVIEW_LIMIT = 20;
const encoder = new TextEncoder();
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// Preserve qualifiers, punctuation and accents. This is equality, never fuzzy matching.
const nameKey = (name: string) => name.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
function field(value: unknown, max: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    encoder.encode(value).byteLength > max ||
    [...value].some((c) => c.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(c)) ||
    /\p{Surrogate}/u.test(value)
  )
    throw new Error('Guide mapping metadata is invalid or exceeds its field limit.');
}

/** Review suggestions only. Run large batches off the viewing thread; publication stays with the owner. */
export function suggestGuideMappings(input: MappingInput): MappingSuggestion[] {
  if (!input || typeof input !== 'object') throw new Error('Guide mapping input is invalid.');
  field(input.guideSourceId, 256);
  if (
    !Array.isArray(input.catalogChannels) ||
    !Array.isArray(input.guideChannels) ||
    input.catalogChannels.length > MAX_RECORDS ||
    input.guideChannels.length > MAX_RECORDS
  )
    throw new Error('Guide mapping input exceeds its record limit.');
  let inputBytes = 0;
  const addBytes = (value: string) => {
    inputBytes += encoder.encode(value).byteLength;
    if (inputBytes > MAX_BYTES) throw new Error('Guide mapping input exceeds its byte limit.');
  };
  const guideRecords = new Map<string, MappingGuideChannel>();
  const byId = new Map<string, MappingGuideChannel>();
  const byName = new Map<string, MappingGuideChannel[]>();
  for (const channel of input.guideChannels) {
    if (!channel || typeof channel !== 'object')
      throw new Error('Guide channel metadata is invalid.');
    field(channel.guideSourceId, 256);
    field(channel.id, 16_384);
    if (!Array.isArray(channel.names) || !channel.names.length || channel.names.length > 32)
      throw new Error('Guide mapping display names are missing or exceed their limit.');
    addBytes(channel.guideSourceId);
    addBytes(channel.id);
    const normalizedNames = new Set<string>();
    for (const name of channel.names) {
      field(name, 512);
      addBytes(name);
      normalizedNames.add(nameKey(name));
    }
    const key = JSON.stringify([channel.guideSourceId, channel.id]);
    const prior = guideRecords.get(key);
    if (prior) {
      if (JSON.stringify(prior.names) !== JSON.stringify(channel.names))
        throw new Error('A guide channel ID has conflicting metadata within its source.');
      continue;
    }
    guideRecords.set(key, channel);
    if (channel.guideSourceId !== input.guideSourceId) continue;
    byId.set(channel.id, channel);
    for (const normalized of normalizedNames) {
      const list = byName.get(normalized) ?? [];
      list.push(channel);
      byName.set(normalized, list);
    }
  }
  for (const matches of byName.values()) matches.sort((a, b) => compare(a.id, b.id));
  const catalog = new Map<string, MappingChannel>();
  for (const channel of input.catalogChannels) {
    if (!channel || typeof channel !== 'object')
      throw new Error('Catalog channel metadata is invalid.');
    field(channel.sourceId, 256);
    field(channel.id, 16_384);
    field(channel.name, 16_384);
    if (channel.providerId !== undefined) field(channel.providerId, 16_384);
    for (const value of [channel.sourceId, channel.id, channel.name, channel.providerId ?? ''])
      addBytes(value);
    const key = JSON.stringify([channel.sourceId, channel.id]);
    const prior = catalog.get(key);
    if (prior && (prior.name !== channel.name || prior.providerId !== channel.providerId))
      throw new Error('A catalog channel ID has conflicting metadata within its source.');
    catalog.set(key, channel);
  }
  const ordered = [...catalog.values()].sort(
    (a, b) => compare(a.sourceId, b.sourceId) || compare(a.id, b.id),
  );
  const result: MappingSuggestion[] = [];
  let outputBytes = 2;
  for (const channel of ordered) {
    const provider = channel.providerId === undefined ? undefined : byId.get(channel.providerId);
    const candidates = provider ? [provider] : (byName.get(nameKey(channel.name)) ?? []);
    const suggestion: MappingSuggestion = {
      catalogSourceId: channel.sourceId,
      appChannelId: channel.id,
      guideSourceId: input.guideSourceId,
      match:
        candidates.length === 0
          ? 'unmatched'
          : candidates.length > 1
            ? 'ambiguous'
            : provider
              ? 'provider-id'
              : 'display-name',
      candidateCount: candidates.length,
      candidatesPreview: candidates.slice(0, PREVIEW_LIMIT).map((candidate) => ({
        xmltvChannelId: candidate.id,
        displayName: candidate.names[0],
      })),
      previewComplete: candidates.length <= PREVIEW_LIMIT,
      reviewRequired: true,
    };
    outputBytes += encoder.encode(JSON.stringify(suggestion)).byteLength + 1;
    if (outputBytes > MAX_BYTES)
      throw new Error('Guide suggestions exceed the review batch limit. Review fewer channels.');
    result.push(suggestion);
  }
  return result;
}
