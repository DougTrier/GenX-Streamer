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

import type { ChannelCandidate, ParsedPlaylist, Source } from '../../catalog/parser';
import type { ProviderGeographyDocuments } from '../../catalog/provider-geography';
import type { PreferredRegion } from '../../location/region';
import { prioritizeRegion } from '../../location/region';
import type { DiscoveryMetadata } from '../../discovery/discovery-metadata';
import type { ScanReview } from '../../discovery/scan';
import { rankScanCandidates } from '../../discovery/scan-ranking';
import { buildDiscoveryMetadataInWorker } from '../../discovery/discovery-metadata-service';
import { enrichGeographyInWorker } from '../../catalog/provider-geography-service';
import { ownCollectedPlaylist } from '../../catalog/owned-collection';
import { fetchAuxiliaryText } from '../../location/fetch';
import defaultMetadataSources from '../../location/metadata-sources.json';

export interface ScanGeography {
  documents: ProviderGeographyDocuments;
  rawCities?: string;
}
export interface ScanSourceCollectorHost {
  inspectSource(
    location: string,
    allowHttp: boolean,
    signal: AbortSignal,
  ): Promise<{ kind: string; text?: string; mime?: string }>;
  parse(text: string, sourceId: string, signal: AbortSignal): Promise<ParsedPlaylist>;
  fetchText?(url: string, signal: AbortSignal, limit: number): Promise<string>;
  enrich?(
    documents: ProviderGeographyDocuments,
    source: Source,
    channels: ChannelCandidate[],
    signal: AbortSignal,
    rawCities?: string,
  ): Promise<ChannelCandidate[]>;
  buildMetadata?(
    channels: string,
    blocklist: string | undefined,
    signal: AbortSignal,
  ): Promise<DiscoveryMetadata>;
  own?(parsed: ParsedPlaylist, signal: AbortSignal): Promise<ParsedPlaylist>;
  scope(): readonly { source: Source }[];
  region(): PreferredRegion | undefined;
  metadataSources?: {
    countries: string;
    channels: string;
    subdivisions: string;
    feeds: string;
    cities: string;
    blocklist: string;
  };
}
const iptvOrg = (location: string) => {
  const url = new URL(location);
  return url.origin === 'https://iptv-org.github.io' && url.pathname.startsWith('/iptv/');
};
const METADATA_LIMIT = 20 * 1024 * 1024;

/** Owns per-scan auxiliary metadata. reset() releases raw documents, not acknowledged work. */
export function createScanSourceCollector(options: ScanSourceCollectorHost) {
  const host = {
    fetchText: fetchAuxiliaryText,
    enrich: enrichGeographyInWorker,
    buildMetadata: buildDiscoveryMetadataInWorker,
    own: ownCollectedPlaylist,
    metadataSources: defaultMetadataSources,
    ...options,
  };
  let geography: Promise<ScanGeography> | undefined;
  let metadata: Promise<DiscoveryMetadata | null> | undefined;
  let ready: DiscoveryMetadata | null = null;
  async function readGeography(signal: AbortSignal): Promise<ScanGeography> {
    let remaining = METADATA_LIMIT;
    const documents = {} as ProviderGeographyDocuments;
    for (const key of ['countries', 'channels', 'subdivisions', 'feeds'] as const) {
      const text = await host.fetchText(host.metadataSources[key], signal, remaining);
      remaining -= new TextEncoder().encode(text).length;
      documents[key] = text;
    }
    let rawCities: string | undefined;
    try {
      rawCities = await host.fetchText(host.metadataSources.cities, signal, 8 * 1024 * 1024);
    } catch {
      signal.throwIfAborted();
    }
    return { documents, rawCities };
  }
  /** Optional: unavailable metadata leaves matching and order exactly as before. */
  function readMetadata(signal: AbortSignal): Promise<DiscoveryMetadata | null> {
    metadata ??= (async () => {
      try {
        const channels = geography
          ? (await geography).documents.channels
          : await host.fetchText(host.metadataSources.channels, signal, METADATA_LIMIT);
        let blocklist: string | undefined;
        try {
          blocklist = await host.fetchText(host.metadataSources.blocklist, signal, 1024 * 1024);
        } catch {
          signal.throwIfAborted();
        }
        ready = await host.buildMetadata(channels, blocklist, signal);
        return ready;
      } catch {
        signal.throwIfAborted();
        return null;
      }
    })();
    return metadata;
  }
  async function collect(source: Source, signal: AbortSignal): Promise<ParsedPlaylist> {
    const scope = host.scope();
    const result = await host.inspectSource(source.location, source.allowHttp ?? false, signal);
    signal.throwIfAborted();
    if (result.kind === 'unsupported')
      throw new Error('This source has no supported channel catalog or media.');
    const definition = scope.find((entry) => entry.source.id === source.id);
    if (scope !== host.scope() || !definition) throw new Error('The scan changed. Start it again.');
    definition.source.contentKind = result.kind as Source['contentKind'];
    definition.source.mediaMime = result.mime;
    const text =
      result.kind === 'catalog' && result.text !== undefined
        ? result.text
        : `#EXTM3U\n#EXTINF:-1 tvg-id="direct" group-title="Custom",${source.name.replace(/[\r\n]/g, ' ')}\n${source.location}\n`;
    const parsed = await host.parse(text, source.id, signal);
    if (iptvOrg(source.location)) {
      try {
        geography ??= readGeography(signal);
        const loaded = await geography;
        parsed.channels = await host.enrich(
          loaded.documents,
          source,
          parsed.channels,
          signal,
          loaded.rawCities,
        );
      } catch {
        signal.throwIfAborted();
        parsed.warnings.push(
          'Regional metadata is unavailable. Existing channel geography is retained; channels without metadata remain Unknown.',
        );
      }
    }
    if (result.kind === 'catalog' && parsed.channels.some((channel) => channel.providerId))
      await readMetadata(signal);
    return host.own(
      {
        ...parsed,
        channels: prioritizeRegion(parsed.channels, host.region(), (c) => c.geography),
      },
      signal,
    );
  }
  return {
    collect,
    readGeography,
    /** Raw documents are released after collection; compact metadata stays for ranking. */
    release() {
      geography = undefined;
    },
    /** New scan scope: forget documents and metadata from any earlier scan. */
    reset() {
      geography = undefined;
      metadata = undefined;
      ready = null;
    },
    /**
     * Native indexed activation hints: published-name matches for the query and
     * demoted IDs. Unavailable metadata, or an over-broad query, sends no hints.
     */
    async discoveryHints(
      query: string,
      signal: AbortSignal,
    ): Promise<{ aliasProviderIds?: string[]; demotedProviderIds?: string[] }> {
      const loaded = await readMetadata(signal);
      if (!loaded) return {};
      const plain = (id: string) => !id.includes('@') && id.length <= 256;
      const aliases = query.trim() ? loaded.matchIds(query, 5_000) : [];
      const all = loaded.demotedIds().filter(plain);
      // Ordering hints are whole or absent; never an arbitrary subset.
      const demoted = all.length <= 50_000 ? all : [];
      return {
        ...(aliases?.length ? { aliasProviderIds: aliases.filter(plain) } : {}),
        ...(demoted.length ? { demotedProviderIds: demoted } : {}),
      };
    },
    aliases: (channel: ChannelCandidate): readonly string[] =>
      ready?.lookup(channel.providerId)?.names ?? [],
    prioritize: (review: ScanReview): ScanReview =>
      rankScanCandidates(review, host.region(), ready ?? undefined),
  };
}
