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

import { boundedUtf8Text } from '../platform/bounded-text';
import {
  parseDeclaredGeography,
  type ChannelGeography,
  type GeographyProvenance,
} from './geography';
export interface Source {
  id: string;
  name: string;
  location: string;
  kind: 'url' | 'file';
  allowHttp?: boolean;
  contentKind?: 'catalog' | 'hls' | 'media';
  mediaMime?: string;
}
export interface Channel {
  id: string;
  sourceId: string;
  providerId?: string;
  name: string;
  category: string;
  urls: string[];
  geography?: ChannelGeography;
  geographyProvenance?: GeographyProvenance[];
}
export type ChannelCandidate = Omit<Channel, 'id'>;
export interface ParsedPlaylist {
  channels: ChannelCandidate[];
  warnings: string[];
}
export const MAX_PLAYLIST_BYTES = 20 * 1024 * 1024;
export const MAX_CHANNELS = 100_000;
const MAX_LINE = 16_384;

export class PlaylistError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlaylistError';
  }
}

function metadata(line: string): { attributes: Map<string, string>; name: string } {
  let quoted = false;
  let comma = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    if (line[i] === ',' && !quoted) {
      comma = i;
      break;
    }
  }
  if (comma < 0 || quoted)
    throw new PlaylistError('metadata', 'An EXTINF entry has malformed quoted metadata.');
  const header = line.slice(8, comma).trim();
  const duration = /^-?\d+(?:\.\d+)?/.exec(header);
  if (!duration) throw new PlaylistError('metadata', 'An EXTINF entry has an invalid duration.');
  const tail = header.slice(duration[0].length);
  const attrs = new Map<string, string>();
  const pattern = /\s+([\w-]+)=(?:"([^"]*)"|([^\s"]+))/gy;
  let offset = 0;
  while (offset < tail.length) {
    if (!tail.slice(offset).trim()) break;
    pattern.lastIndex = offset;
    const match = pattern.exec(tail);
    if (!match) throw new PlaylistError('metadata', 'An EXTINF entry has malformed attributes.');
    const key = match[1]!.toLowerCase();
    if (attrs.has(key))
      throw new PlaylistError('metadata', 'An EXTINF entry repeats an attribute.');
    attrs.set(key, match[2] ?? match[3] ?? '');
    offset = pattern.lastIndex;
  }
  return { attributes: attrs, name: line.slice(comma + 1).trim() };
}

/** Validate only inert exclusions; older WebViews expose non-special URLs as opaque. */
function unsupportedNetworkProtocol(line: string): string | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(line)?.[1]?.toLowerCase();
  if (!scheme || !['srt', 'rtmp', 'mmsh', 'rtsp'].includes(scheme)) return;
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)(?:[/?#].*)?$/i.exec(line)?.[1];
  // No credentials, escaped host syntax, backslashes, empty/invalid ports or opaque paths.
  if (!authority || !/^(?:\[[0-9a-f:.]+\]|[^\s\\/@:%?#]+)(?::[0-9]{1,5})?$/i.test(authority))
    throw new PlaylistError('protocol', 'Only HTTP and HTTPS stream URLs are supported.');
  try {
    // HTTPS authority parsing is consistent across supported WebViews; nothing is fetched.
    const parsed = new URL(`https://${authority}/`);
    if (!parsed.hostname || parsed.username || parsed.password) throw new Error('authority');
  } catch {
    throw new PlaylistError('protocol', 'Only HTTP and HTTPS stream URLs are supported.');
  }
  return `${scheme}:`;
}

export function parseM3u(text: string, sourceId: string): ParsedPlaylist {
  if (!sourceId.trim()) throw new PlaylistError('source', 'A source identity is required.');
  if (new TextEncoder().encode(text).byteLength > MAX_PLAYLIST_BYTES)
    throw new PlaylistError('size', 'Playlist exceeds the 20 MiB limit.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = lines[0]?.trim() ?? '';
  if (!boundedUtf8Text(header, MAX_LINE, true))
    throw new PlaylistError('line', 'Playlist metadata exceeds the line size limit.');
  // Optional header attributes are inert metadata; EPG hints never initiate requests here.
  if (!/^#EXTM3U(?:[\t ]|$)/.test(header))
    throw new PlaylistError('header', 'This file is not an extended M3U playlist.');
  const channels: ChannelCandidate[] = [];
  const warnings: string[] = [];
  let attemptedEntries = 0;
  let unavailablePlaceholders = 0;
  let oversizedNormalizedUrls = 0;
  // Publisher-declared request headers are ignored (never forwarded); count them so a
  // failed check can be explained instead of looking like an unresponsive stream.
  let declaredHeaderEntries = 0;
  let pendingDeclaresHeaders = false;
  const unsupported = new Map<string, number>();
  let pending: ReturnType<typeof metadata> | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!boundedUtf8Text(line, MAX_LINE, true))
      throw new PlaylistError('line', 'Playlist metadata exceeds the line size limit.');
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      if (pending) throw new PlaylistError('entry', 'A channel entry is missing its stream URL.');
      pending = metadata(line);
      pendingDeclaresHeaders =
        pending.attributes.has('http-user-agent') || pending.attributes.has('http-referrer');
      continue;
    }
    if (line.startsWith('#')) {
      if (pending && /^#(?:EXTVLCOPT:http-(?:user-agent|referrer)=|EXTHTTP:)/iu.test(line))
        pendingDeclaresHeaders = true;
      continue;
    }
    if (!pending) throw new PlaylistError('entry', 'A stream URL has no EXTINF metadata.');
    if (!pending.name) throw new PlaylistError('name', 'A channel has an empty name.');
    if (++attemptedEntries > MAX_CHANNELS)
      throw new PlaylistError('entries', 'Playlist exceeds the 100,000 channel limit.');
    if (line === '[NO PUBLIC STREAM]') {
      unavailablePlaceholders++;
      pending = undefined;
      continue;
    }
    const excludedProtocol = unsupportedNetworkProtocol(line);
    if (excludedProtocol) {
      unsupported.set(excludedProtocol, (unsupported.get(excludedProtocol) ?? 0) + 1);
      pending = undefined;
      continue;
    }
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      throw new PlaylistError('url', 'A channel has an invalid stream URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new PlaylistError('protocol', 'Only HTTP and HTTPS stream URLs are supported.');
    }
    // URL normalization may percent-encode a bounded input into a larger address.
    if (!boundedUtf8Text(url.href, MAX_LINE, true)) {
      oversizedNormalizedUrls++;
      pending = undefined;
      continue;
    }
    const providerId = pending.attributes.get('tvg-id')?.trim();
    const declared = parseDeclaredGeography(sourceId, providerId, pending.attributes);
    warnings.push(...declared.warnings.map((message) => `Entry ${attemptedEntries}: ${message}`));
    channels.push({
      sourceId,
      ...(providerId ? { providerId } : {}),
      name: pending.name,
      category: pending.attributes.get('group-title')?.trim() ?? '',
      urls: [url.href],
      ...(declared.geography
        ? { geography: declared.geography, geographyProvenance: declared.geographyProvenance }
        : {}),
    });
    if (pendingDeclaresHeaders) declaredHeaderEntries++;
    pending = undefined;
  }
  if (pending) throw new PlaylistError('entry', 'The last channel entry has no stream URL.');
  if (!channels.length)
    throw new PlaylistError(
      'empty',
      'The playlist contains no channels; the previous catalog was retained.',
    );
  if (unsupported.size)
    warnings.push(
      `Skipped unsupported stream protocols: ${[...unsupported].map(([scheme, count]) => `${scheme.slice(0, -1)} ${count}`).join(', ')}. Only HTTP and HTTPS streams were collected.`,
    );
  if (unavailablePlaceholders)
    warnings.push(
      `Skipped unavailable stream placeholders: ${unavailablePlaceholders}. No stream URLs were invented.`,
    );
  if (declaredHeaderEntries)
    warnings.push(
      `${declaredHeaderEntries} channels declare a required User-Agent or Referrer header, which GenX does not send. They may fail checks or playback here even when the stream works elsewhere.`,
    );
  if (oversizedNormalizedUrls)
    warnings.push(
      `Skipped stream URLs exceeding the 16,384-byte limit after normalization: ${oversizedNormalizedUrls}. Other supported channels were retained.`,
    );
  return { channels, warnings };
}

function identity(channel: ChannelCandidate): string {
  return JSON.stringify([
    channel.sourceId,
    channel.providerId ?? '',
    channel.name.normalize('NFKC').trim().toLocaleLowerCase('en-US'),
    channel.category.normalize('NFKC').trim().toLocaleLowerCase('en-US'),
  ]);
}

export interface ReconciliationScope {
  sourceId: string;
  ambiguousProviderKeys: readonly string[];
  ambiguousMetadataKeys: readonly string[];
}
const providerIdentity = (c: ChannelCandidate) => JSON.stringify([c.sourceId, c.providerId]);
export function channelReconciliationScope(
  candidates: readonly ChannelCandidate[],
  sourceId: string,
): ReconciliationScope {
  if (candidates.length > MAX_CHANNELS || candidates.some((c) => c.sourceId !== sourceId))
    throw new PlaylistError('identity', 'Channel reconciliation scope is invalid.');
  const providers = new Map<string, number>(),
    metadata = new Map<string, number>();
  for (const candidate of candidates) {
    const key = identity(candidate);
    metadata.set(key, (metadata.get(key) ?? 0) + 1);
    if (candidate.providerId) {
      const provider = providerIdentity(candidate);
      providers.set(provider, (providers.get(provider) ?? 0) + 1);
    }
  }
  return {
    sourceId,
    ambiguousProviderKeys: [...providers].filter(([, count]) => count > 1).map(([key]) => key),
    ambiguousMetadataKeys: [...metadata].filter(([, count]) => count > 1).map(([key]) => key),
  };
}
function validateReconciliationScope(
  scope: ReconciliationScope,
  candidates: readonly ChannelCandidate[],
): void {
  if (
    !scope ||
    typeof scope.sourceId !== 'string' ||
    !boundedUtf8Text(scope.sourceId, MAX_LINE) ||
    Object.keys(scope).some(
      (key) => !['sourceId', 'ambiguousProviderKeys', 'ambiguousMetadataKeys'].includes(key),
    ) ||
    candidates.some((c) => c.sourceId !== scope.sourceId)
  )
    throw new PlaylistError('identity', 'Channel reconciliation scope is invalid.');
  for (const [values, length] of [
    [scope.ambiguousProviderKeys, 2],
    [scope.ambiguousMetadataKeys, 4],
  ] as const) {
    if (
      !Array.isArray(values) ||
      values.length > MAX_CHANNELS ||
      new Set(values).size !== values.length
    )
      throw new PlaylistError('identity', 'Channel reconciliation scope is invalid.');
    for (const key of values) {
      let tuple: unknown;
      try {
        tuple = JSON.parse(key);
      } catch {
        throw new PlaylistError('identity', 'Channel reconciliation scope is invalid.');
      }
      if (
        !Array.isArray(tuple) ||
        tuple.length !== length ||
        tuple[0] !== scope.sourceId ||
        tuple.some((part) => typeof part !== 'string' || !boundedUtf8Text(part, MAX_LINE, true)) ||
        JSON.stringify(tuple) !== key
      )
        throw new PlaylistError('identity', 'Channel reconciliation scope is invalid.');
    }
  }
}

/** Exact full records can disambiguate unchanged variants, never URLs alone. */
function channelBaseTuple(c: ChannelCandidate): string {
  return JSON.stringify([c.sourceId, c.providerId ?? null, c.name, c.category, c.urls]);
}
function retainedGeographyMatches(
  candidate: ChannelCandidate,
  previous: ChannelCandidate,
): boolean {
  return (
    (['country', 'region', 'state'] as const).every(
      (field) =>
        candidate.geography?.[field] === undefined ||
        candidate.geography[field] === previous.geography?.[field],
    ) &&
    (candidate.geographyProvenance === undefined ||
      JSON.stringify(candidate.geographyProvenance) ===
        JSON.stringify(previous.geographyProvenance))
  );
}
function exactChannelTuple(c: ChannelCandidate): string {
  return JSON.stringify([
    c.sourceId,
    c.providerId ?? null,
    c.name,
    c.category,
    c.urls,
    c.geography
      ? [c.geography.country ?? null, c.geography.region ?? null, c.geography.state ?? null]
      : null,
    c.geographyProvenance?.map((p) => [
      p.field,
      p.value,
      p.sourceId,
      p.providerId ?? null,
      p.kind,
      p.scope,
    ]) ?? null,
  ]);
}

/** Ambiguous identities remain distinct; URLs and list order never establish identity. */
export function reconcileChannels(
  candidates: ChannelCandidate[],
  previous: Channel[],
  createId: () => string = () => crypto.randomUUID(),
  scope?: ReconciliationScope,
): Channel[] {
  if (scope) validateReconciliationScope(scope, candidates);
  const ambiguousProviders = new Set(scope?.ambiguousProviderKeys);
  const ambiguousMetadata = new Set(scope?.ambiguousMetadataKeys);
  const oldByMetadata = new Map<string, Channel[]>();
  const oldByExactTuple = new Map<string, Channel[]>();
  const oldByBaseTuple = new Map<string, Channel[]>();
  const exactCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = exactChannelTuple(candidate);
    exactCounts.set(key, (exactCounts.get(key) ?? 0) + 1);
  }
  const newCounts = new Map<string, number>();
  const providerCounts = new Map<string, number>();
  const oldProviders = new Map<string, Channel[]>();
  const providerKey = providerIdentity;
  for (const old of previous) {
    const base = channelBaseTuple(old);
    const baseBucket = oldByBaseTuple.get(base);
    if (baseBucket) baseBucket.push(old);
    else oldByBaseTuple.set(base, [old]);
    const exact = exactChannelTuple(old);
    const exactBucket = oldByExactTuple.get(exact);
    if (exactBucket) exactBucket.push(old);
    else oldByExactTuple.set(exact, [old]);
    const key = identity(old);
    const bucket = oldByMetadata.get(key);
    if (bucket) bucket.push(old);
    else oldByMetadata.set(key, [old]);
    if (old.providerId) {
      const p = providerKey(old);
      const providers = oldProviders.get(p);
      if (providers) providers.push(old);
      else oldProviders.set(p, [old]);
    }
  }
  for (const c of candidates) {
    const key = identity(c);
    newCounts.set(key, (newCounts.get(key) ?? 0) + 1);
    if (c.providerId) {
      const p = providerKey(c);
      providerCounts.set(p, (providerCounts.get(p) ?? 0) + 1);
    }
  }
  const used = new Set<string>();
  const previousById = new Map(previous.map((channel) => [channel.id, channel]));
  const compatibleExact = new Map<string, Channel[]>();
  return candidates.map((c) => {
    const old = oldByMetadata.get(identity(c));
    const exactKey = exactChannelTuple(c);
    let exact = oldByExactTuple.get(exactKey);
    if (!exact && scope) {
      exact = compatibleExact.get(exactKey);
      if (!exact) {
        exact =
          oldByBaseTuple
            .get(channelBaseTuple(c))
            ?.filter((old) => retainedGeographyMatches(c, old)) ?? [];
        compatibleExact.set(exactKey, exact);
      }
    }
    let id: string | undefined;
    if (exact?.length === 1 && !used.has(exact[0]!.id)) id = exact[0]!.id;
    else if (
      scope &&
      exact?.length &&
      exactCounts.get(exactKey) === 1 &&
      exact.every((old) => exactChannelTuple(old) === exactChannelTuple(exact[0]!))
    ) {
      // Update one deterministic identical copy; retain every existing ID and user choice.
      const preferred = exact.reduce((a, b) => (a.id < b.id ? a : b));
      if (!used.has(preferred.id)) id = preferred.id;
    }
    if (
      !id &&
      c.providerId &&
      providerCounts.get(providerKey(c)) === 1 &&
      !ambiguousProviders.has(providerKey(c))
    ) {
      const matching = oldProviders.get(providerKey(c));
      if (matching?.length === 1) id = matching[0]!.id;
      else if (!matching?.length)
        id = `provider:${encodeURIComponent(c.sourceId)}:${encodeURIComponent(c.providerId)}`;
    }
    if (
      !id &&
      old?.length === 1 &&
      newCounts.get(identity(c)) === 1 &&
      !ambiguousMetadata.has(identity(c))
    )
      id = old[0]!.id;
    if (!id || used.has(id)) id = createId();
    if (used.has(id))
      throw new PlaylistError('identity', 'The identity generator returned a duplicate identity.');
    used.add(id);
    const prior = previousById.get(id);
    const geography = { ...prior?.geography, ...c.geography };
    // A changed country cannot retain an incompatible previous subdivision.
    if (geography.state && !geography.state.startsWith((geography.country ?? '') + '-'))
      delete geography.state;
    const geographyProvenance = (['country', 'region', 'state'] as const).flatMap((field) => {
      const value = geography[field];
      if (!value) return [];
      const provenance =
        c.geographyProvenance?.find((p) => p.field === field && p.value === value) ??
        prior?.geographyProvenance?.find((p) => p.field === field && p.value === value);
      return provenance ? [{ ...provenance }] : [];
    });
    return {
      ...c,
      urls: [...c.urls],
      id,
      ...(Object.keys(geography).length
        ? { geography, ...(geographyProvenance.length ? { geographyProvenance } : {}) }
        : {}),
    };
  });
}
