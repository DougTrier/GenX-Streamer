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

import type { Source } from '../catalog/parser';
import { GUIDE_SOURCE_LIMIT } from './limits';
import { boundedUtf8Text } from '../platform/bounded-text';

export interface DiscoveredGuide {
  location: string;
  name: string;
  playlistNames: string[];
  allowHttp: false;
  requiresHttpPermission: boolean;
  registryId?: string;
  provenance?: string;
  limitations?: string;
}
/** User-reviewed discovery providers. These describe guides, never streaming channels or mappings. */
export interface ReviewedGuideProvider {
  id: string;
  name: string;
  location: string;
  provenance: string;
  limitations: string;
}
export interface GuideDiscoveryOptions {
  registry?: readonly ReviewedGuideProvider[];
}
export interface GuideDiscoveryResult {
  candidates: DiscoveredGuide[];
  outcomes: { sourceId: string; status: 'found' | 'none' | 'failed'; message: string }[];
}
export type PlaylistGuideInspector = (
  sourceUrl: string,
  allowHttp: boolean,
  signal: AbortSignal,
) => Promise<{ kind: string; text?: string }>;

/** Saved playlist headers are inspected; injected reviewed providers are suggestions only. */
export async function discoverPlaylistGuides(
  sources: readonly Source[],
  inspect: PlaylistGuideInspector,
  signal: AbortSignal,
  options: GuideDiscoveryOptions = {},
): Promise<GuideDiscoveryResult> {
  signal.throwIfAborted();
  if (sources.length > 100) throw new Error('Guide discovery supports at most 100 saved sources.');
  const candidates = new Map<string, DiscoveredGuide>();
  const registry = options.registry ?? [];
  if (!Array.isArray(registry) || registry.length > GUIDE_SOURCE_LIMIT)
    throw new Error('Guide provider registry exceeds its discovery limit.');
  const registryIds = new Set<string>();
  // Validate and snapshot the complete registry before acquisition. Caller edits cannot relabel a run.
  for (const provider of registry) {
    if (
      !provider ||
      !boundedUtf8Text(provider.id, 256) ||
      !provider.id.trim() ||
      !boundedUtf8Text(provider.name, 512) ||
      !provider.name.trim() ||
      !boundedUtf8Text(provider.limitations, 2048) ||
      !provider.limitations.trim() ||
      registryIds.has(provider.id)
    )
      throw new Error('Guide provider registry is invalid.');
    registryIds.add(provider.id);
    try {
      if (!boundedUtf8Text(provider.location, 16_384)) throw new Error('location');
      const location = headerHints(`#EXTM3U tvg-url="${provider.location}"`);
      if (location.length !== 1 || location[0] !== provider.location) throw new Error('location');
      if (!boundedUtf8Text(provider.provenance, 2048)) throw new Error('provenance');
      const provenance = headerHints(`#EXTM3U tvg-url="${provider.provenance}"`);
      if (
        provenance.length !== 1 ||
        provenance[0] !== provider.provenance ||
        new URL(provider.provenance).protocol !== 'https:' ||
        candidates.has(provider.location)
      )
        throw new Error('provenance');
    } catch {
      throw new Error('Guide provider registry is invalid.');
    }
    candidates.set(provider.location, {
      location: provider.location,
      name: provider.name,
      playlistNames: [],
      allowHttp: false,
      requiresHttpPermission: new URL(provider.location).protocol === 'http:',
      registryId: provider.id,
      provenance: provider.provenance,
      limitations: provider.limitations,
    });
  }
  const outcomes: GuideDiscoveryResult['outcomes'] = [];
  for (const source of sources) {
    signal.throwIfAborted();
    if (source.kind !== 'url' || (source.contentKind && source.contentKind !== 'catalog')) {
      outcomes.push({
        sourceId: source.id,
        status: 'none',
        message: 'No saved online playlist to inspect.',
      });
      continue;
    }
    try {
      const response = await inspect(source.location, source.allowHttp === true, signal);
      signal.throwIfAborted();
      if (response.kind !== 'catalog' || typeof response.text !== 'string') {
        outcomes.push({
          sourceId: source.id,
          status: 'none',
          message: 'This source did not return a channel playlist.',
        });
        continue;
      }
      const hints = headerHints(response.text);
      const additions = hints.filter((hint) => !candidates.has(hint));
      if (candidates.size + additions.length > GUIDE_SOURCE_LIMIT) throw new Error('hint-limit');
      // Whole source admission precedes mutation: a rejected playlist cannot leave partial hints.
      for (const location of hints) {
        const existing = candidates.get(location);
        if (existing) {
          if (!existing.playlistNames.includes(source.name))
            existing.playlistNames.push(source.name);
        } else {
          candidates.set(location, {
            location,
            name: `${source.name} program guide`,
            playlistNames: [source.name],
            allowHttp: false,
            requiresHttpPermission: new URL(location).protocol === 'http:',
          });
        }
      }
      outcomes.push({
        sourceId: source.id,
        status: hints.length ? 'found' : 'none',
        message: hints.length
          ? 'Program guide references found.'
          : 'This playlist does not provide a program guide reference.',
      });
    } catch {
      signal.throwIfAborted();
      outcomes.push({
        sourceId: source.id,
        status: 'failed',
        message:
          'Could not inspect this playlist, or its guide references are invalid or exceed discovery limits. Retry or review this source.',
      });
    }
  }
  signal.throwIfAborted();
  return { candidates: [...candidates.values()], outcomes };
}

function headerHints(text: string): string[] {
  const end = text.indexOf('\n');
  const firstLine = text.slice(0, end < 0 ? undefined : end).replace(/^\uFEFF/, '');
  if (!boundedUtf8Text(firstLine.replace(/\r$/, ''), 16_384, true)) throw new Error('header');
  const header = firstLine.trim();
  if (!/^#EXTM3U(?:[\t ]|$)/.test(header)) throw new Error('header');
  const tail = header.slice(7);
  const attributes = /[\t ]+([\w-]+)=(?:"([^"]*)"|([^\s"]+))/gy;
  let offset = 0;
  const hints = new Set<string>();
  while (offset < tail.length) {
    if (!tail.slice(offset).trim()) break;
    attributes.lastIndex = offset;
    const match = attributes.exec(tail);
    if (!match) throw new Error('attributes');
    offset = attributes.lastIndex;
    if (!['x-tvg-url', 'url-tvg', 'tvg-url'].includes(match[1]!.toLowerCase())) continue;
    const value = match[2] ?? match[3] ?? '';
    if (!value.trim()) throw new Error('hint');
    for (const location of value.split(',')) {
      const raw = location.trim();
      if (
        !raw ||
        /[\s\\]/u.test(raw) ||
        [...raw].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        /%(?![a-f\d]{2})/iu.test(raw)
      )
        throw new Error('hint');
      const url = new URL(raw);
      if (
        !/^https?:\/\//i.test(raw) ||
        !['https:', 'http:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error('hint');
      hints.add(raw);
      if (hints.size > 20) throw new Error('hint-limit');
    }
  }
  return [...hints];
}
