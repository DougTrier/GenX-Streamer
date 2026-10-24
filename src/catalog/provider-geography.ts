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

import { MAX_CHANNELS, MAX_PLAYLIST_BYTES, type ChannelCandidate, type Source } from './parser';
import {
  validateGeographyShape,
  validateGeographyProvenance,
  type ChannelGeography,
} from './geography';
import { boundedUtf8Text } from '../platform/bounded-text';

export type ProviderGeographyIssue =
  | 'source-not-admitted'
  | 'provider-not-found'
  | 'unknown-country'
  | 'unknown-subdivision'
  | 'unknown-city'
  | 'unsupported-broadcast-area'
  | 'ambiguous-broadcast-area'
  | 'inconsistent-geography'
  | 'declared-geography-conflict';
interface IndexedGeography {
  geography: Readonly<ChannelGeography>;
  issues: readonly ProviderGeographyIssue[];
}
export interface ProviderGeographyIndex {
  lookup(providerId: string): IndexedGeography | undefined;
}
export interface ProviderGeographyDocuments {
  channels: string;
  countries: string;
  subdivisions: string;
  /** Current official API puts broadcast_area on feeds, not channels. */
  feeds?: string;
  cities?: string;
}

export function prepareProviderGeographyDocuments(
  documents: ProviderGeographyDocuments,
  rawCities?: string,
): ProviderGeographyDocuments {
  let remaining = MAX_PLAYLIST_BYTES;
  for (const value of [
    documents.countries,
    documents.channels,
    documents.subdivisions,
    documents.feeds,
    documents.cities,
  ]) {
    if (value === undefined) continue;
    if (!boundedUtf8Text(value, remaining))
      throw new Error('Provider geography documents exceed 20 MiB.');
    remaining -= new TextEncoder().encode(value).length;
  }
  if (rawCities === undefined) return documents;
  if (!boundedUtf8Text(rawCities, 8 * 1024 * 1024))
    throw new Error('Provider cities exceed 8 MiB.');
  const compact = compactProviderCities(rawCities, documents.feeds ?? '[]');
  if (!boundedUtf8Text(compact, remaining))
    throw new Error('Provider geography documents exceed 20 MiB.');
  return { ...documents, cities: compact };
}

/** Off-thread projection keeps the existing geography snapshot budget; no guessed city locations. */
export function compactProviderCities(citiesRaw: string, feedsRaw: string): string {
  if (
    !boundedUtf8Text(citiesRaw, MAX_PLAYLIST_BYTES) ||
    !boundedUtf8Text(feedsRaw, MAX_PLAYLIST_BYTES - new TextEncoder().encode(citiesRaw).length)
  )
    throw new Error('Provider city metadata exceeds 20 MiB.');
  const cities: unknown = JSON.parse(citiesRaw),
    feeds: unknown = JSON.parse(feedsRaw);
  if (
    !Array.isArray(cities) ||
    !Array.isArray(feeds) ||
    cities.length > MAX_CHANNELS ||
    feeds.length > MAX_CHANNELS ||
    !cities.every(object) ||
    !feeds.every(object)
  )
    throw new Error('Provider city metadata is invalid.');
  const requested = new Set<string>();
  for (const feed of feeds) {
    if (!Array.isArray(feed.broadcast_area) || feed.broadcast_area.length > 256)
      throw new Error('Provider broadcast area is invalid.');
    for (const area of feed.broadcast_area) {
      text(area, 64);
      if (area.startsWith('ct/')) requested.add(area.slice(3));
    }
  }
  return JSON.stringify(
    cities
      .filter((city) => requested.has(city.code as string))
      .map((city) => ({
        code: city.code,
        country: city.country,
        subdivision: city.subdivision,
      })),
  );
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, max = 16_384): asserts value is string {
  if (
    !boundedUtf8Text(value, max) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('Provider geography metadata is invalid.');
}

/** Pure bounded normalization of supplied official API snapshots. Run preparation off the viewing thread. */
export function createProviderGeographyIndex(
  documents: ProviderGeographyDocuments,
): ProviderGeographyIndex {
  let remaining = MAX_PLAYLIST_BYTES;
  function rows(raw: string): Record<string, unknown>[] {
    if (!boundedUtf8Text(raw, remaining))
      throw new Error('Provider geography documents exceed 20 MiB.');
    remaining -= new TextEncoder().encode(raw).byteLength;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('Provider geography document is invalid JSON.');
    }
    if (!Array.isArray(value) || value.length > MAX_CHANNELS || !value.every(object))
      throw new Error('Provider geography document exceeds its record limit or schema.');
    return value;
  }
  const countries = new Set<string>();
  for (const country of rows(documents.countries)) {
    text(country.code, 2);
    validateGeographyShape({ country: country.code });
    if (countries.has(country.code)) throw new Error('Duplicate provider country code.');
    countries.add(country.code);
  }
  const states = new Map<string, string>();
  const canonicalStates = new Map<string, string>();
  for (const subdivision of rows(documents.subdivisions)) {
    text(subdivision.code, 11);
    text(subdivision.country, 2);
    // The official API uses UK country codes and ISO GB subdivision prefixes.
    // Bridge only this declared combination; unrelated invalid records still refuse the snapshot.
    const canonicalState =
      subdivision.country === 'UK' && subdivision.code.startsWith('GB-')
        ? `UK-${subdivision.code.slice(3)}`
        : subdivision.code;
    validateGeographyShape({ country: subdivision.country, state: canonicalState });
    if (!countries.has(subdivision.country) || states.has(subdivision.code))
      throw new Error('Invalid or duplicate provider subdivision.');
    states.set(subdivision.code, subdivision.country);
    canonicalStates.set(subdivision.code, canonicalState);
  }
  const channelCountries = new Map<string, string>();
  const cities = new Map<string, { country: string; state?: string }>();
  for (const city of documents.cities === undefined ? [] : rows(documents.cities)) {
    text(city.code, 32);
    text(city.country, 2);
    if (!countries.has(city.country) || cities.has(city.code))
      throw new Error('Invalid or duplicate provider city.');
    const state = city.subdivision;
    if (state !== null && state !== undefined) {
      text(state, 11);
      if (states.get(state) !== city.country) throw new Error('Invalid provider city subdivision.');
    }
    cities.set(city.code, {
      country: city.country,
      ...(typeof state === 'string' ? { state: canonicalStates.get(state)! } : {}),
    });
  }
  const index = new Map<string, IndexedGeography>();
  for (const channel of rows(documents.channels)) {
    text(channel.id);
    text(channel.country, 2);
    validateGeographyShape({ country: channel.country });
    if (channel.id.includes('@') || channelCountries.has(channel.id))
      throw new Error('Duplicate or invalid provider channel identity.');
    channelCountries.set(channel.id, channel.country);
    index.set(channel.id, {
      geography: countries.has(channel.country) ? { country: channel.country } : {},
      issues: countries.has(channel.country) ? [] : ['unknown-country'],
    });
  }
  for (const feed of documents.feeds === undefined ? [] : rows(documents.feeds)) {
    text(feed.channel);
    text(feed.id);
    if (feed.id.includes('@') || !channelCountries.has(feed.channel))
      throw new Error('Provider feed channel identity is invalid.');
    const key = `${feed.channel}@${feed.id}`;
    if (index.has(key)) throw new Error('Duplicate provider feed identity.');
    if (
      !Array.isArray(feed.broadcast_area) ||
      feed.broadcast_area.length > 256 ||
      !feed.broadcast_area.every((area) => boundedUtf8Text(area, 64))
    )
      throw new Error('Provider broadcast area is invalid or exceeds its limit.');
    const origin = index.get(feed.channel)!;
    const geography = { ...origin.geography };
    const issues = new Set<ProviderGeographyIssue>(origin.issues);
    const declaredCountries = new Set<string>();
    const declaredStates = new Set<string>();
    for (const area of feed.broadcast_area as string[]) {
      if (area.startsWith('c/')) {
        const country = area.slice(2);
        if (countries.has(country)) declaredCountries.add(country);
        else issues.add('unknown-country');
      } else if (area.startsWith('s/')) {
        const state = area.slice(2);
        const country = states.get(state);
        if (country) {
          declaredStates.add(canonicalStates.get(state)!);
          declaredCountries.add(country);
        } else issues.add('unknown-subdivision');
      } else if (area.startsWith('ct/')) {
        const city = cities.get(area.slice(3));
        if (city) {
          declaredCountries.add(city.country);
          if (city.state) declaredStates.add(city.state);
        } else issues.add('unknown-city');
      } else issues.add('unsupported-broadcast-area');
    }
    if (declaredCountries.size > 1 || declaredStates.size > 1)
      issues.add('ambiguous-broadcast-area');
    if (
      geography.country &&
      [...declaredCountries].some((country) => country !== geography.country)
    )
      issues.add('inconsistent-geography');
    if (
      geography.country &&
      declaredCountries.size === 1 &&
      declaredStates.size === 1 &&
      !issues.size
    )
      geography.state = [...declaredStates][0];
    index.set(key, { geography, issues: [...issues] });
  }
  return {
    lookup(providerId) {
      text(providerId);
      const found = index.get(providerId);
      return found ? { geography: { ...found.geography }, issues: [...found.issues] } : undefined;
    },
  };
}

/** Only an exact provider namespace in an explicitly admitted catalog source can be enriched. */
export function enrichProviderGeography(
  channel: ChannelCandidate,
  source: Source,
  index: ProviderGeographyIndex,
  options: { allowedSourceLocations: readonly string[] },
): { channel: ChannelCandidate; issues: ProviderGeographyIssue[] } {
  if (
    !Array.isArray(options.allowedSourceLocations) ||
    options.allowedSourceLocations.length > 100 ||
    !options.allowedSourceLocations.every((location) => boundedUtf8Text(location, 16_384))
  )
    throw new Error('Provider geography source scope exceeds its limit.');
  if (
    source.kind !== 'url' ||
    (source.contentKind !== undefined && source.contentKind !== 'catalog') ||
    source.id !== channel.sourceId ||
    !options.allowedSourceLocations.includes(source.location)
  )
    return { channel, issues: ['source-not-admitted'] };
  const found = channel.providerId ? index.lookup(channel.providerId) : undefined;
  if (!found) return { channel, issues: ['provider-not-found'] };
  const existing = channel.geography ?? {};
  validateGeographyShape(existing);
  if (channel.geographyProvenance !== undefined)
    validateGeographyProvenance(channel.geographyProvenance, existing, channel.sourceId);
  if (
    (['country', 'state', 'region'] as const).some(
      (field) =>
        existing[field] && found.geography[field] && existing[field] !== found.geography[field],
    ) ||
    (existing.state &&
      found.geography.country &&
      !existing.state.startsWith(found.geography.country + '-'))
  )
    return { channel, issues: [...found.issues, 'declared-geography-conflict'] };
  const additions = (['country', 'state'] as const).filter(
    (field) => found.geography[field] && !existing[field],
  );
  if (!additions.length) return { channel, issues: [...found.issues] };
  const geography = validateGeographyShape({ ...found.geography, ...existing });
  return {
    channel: {
      ...channel,
      geography,
      geographyProvenance: [
        ...(channel.geographyProvenance ?? []),
        ...additions.map((field) => ({
          field,
          value: geography[field]!,
          sourceId: source.id,
          providerId: channel.providerId,
          kind: 'provider' as const,
          scope: field === 'country' ? ('channel-origin' as const) : ('provider-declared' as const),
        })),
      ],
    },
    issues: [...found.issues],
  };
}
