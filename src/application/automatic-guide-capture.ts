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

import { emptyCatalog, parseCatalog, validateCatalog, type Source } from '../catalog';
import {
  defaultPreferences,
  importPreferences,
  validatePreferences,
  type Preferences,
} from '../preferences';
import { validateProviderRegistry } from '../discovery/provider-registry';
import type { ReviewedGuideProvider } from '../guide/discovery';
import {
  REVIEWED_GUIDE_ALIAS_LOCATION,
  buildReviewedGuideAliases,
  validateReviewedGuideAliases,
  type GuideCommitAliases,
} from '../guide/reviewed-aliases';
import { boundedUtf8Text } from '../platform/bounded-text';

export interface AutomaticGuideSavedSnapshot {
  catalog: string | null;
  preferences: string | null;
  catalogRevision: string;
}
export interface AutomaticGuideCapture {
  catalogRevision: string;
  channelCount: number;
  sources: readonly Source[];
  registry: readonly ReviewedGuideProvider[];
  preferredRegion: Preferences['preferredRegion'];
  automaticGuideUpdates: boolean;
  preferenceKey: string;
  aliases: readonly GuideCommitAliases[];
  /** Declared or ID-suffix countries of saved channels (catalog codes, UK not GB). */
  catalogCountries?: readonly string[];
}
export const automaticGuidePreferenceKey = (
  preferences: Pick<
    Preferences,
    'reviewedGuideProviders' | 'preferredRegion' | 'automaticGuideUpdates'
  >,
): string =>
  JSON.stringify([
    preferences.reviewedGuideProviders,
    preferences.preferredRegion,
    preferences.automaticGuideUpdates !== false,
  ]);

/** Pure worker boundary: validate one atomic saved pair, return no complete channel list. */
export function captureAutomaticGuide(
  snapshot: AutomaticGuideSavedSnapshot,
): AutomaticGuideCapture {
  if (
    !snapshot ||
    typeof snapshot.catalogRevision !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(snapshot.catalogRevision) ||
    BigInt(snapshot.catalogRevision) > 9223372036854775807n ||
    (snapshot.catalog !== null && !boundedUtf8Text(snapshot.catalog, 20 * 1024 * 1024)) ||
    (snapshot.preferences !== null && !boundedUtf8Text(snapshot.preferences, 20 * 1024 * 1024))
  )
    throw new Error('The saved program guide snapshot is invalid.');
  const catalog = snapshot.catalog === null ? emptyCatalog() : parseCatalog(snapshot.catalog);
  const preferences =
    snapshot.preferences === null ? defaultPreferences() : importPreferences(snapshot.preferences);
  const removed = new Set(preferences.removedChannels);
  const aliases = buildReviewedGuideAliases(
    REVIEWED_GUIDE_ALIAS_LOCATION,
    catalog,
    preferences.removedChannels,
  );
  const countries = new Set<string>();
  for (const channel of catalog.channels) {
    if (removed.has(channel.id) || countries.size >= 300) continue;
    const suffix = /\.([a-z]{2})(?:@[^@]*)?$/i.exec(channel.providerId ?? '')?.[1];
    for (const raw of [channel.geography?.country, suffix]) {
      const code = raw?.toUpperCase();
      if (code && /^[A-Z]{2}$/.test(code)) countries.add(code === 'GB' ? 'UK' : code);
    }
  }
  return validateAutomaticGuideCapture({
    catalogRevision: snapshot.catalogRevision,
    channelCount: catalog.channels.filter((channel) => !removed.has(channel.id)).length,
    sources: catalog.sources,
    registry: preferences.reviewedGuideProviders ?? [],
    preferredRegion: preferences.preferredRegion,
    automaticGuideUpdates: preferences.automaticGuideUpdates !== false,
    preferenceKey: automaticGuidePreferenceKey(preferences),
    aliases: aliases ? [aliases] : [],
    catalogCountries: [...countries].slice(0, 300).sort(),
  });
}

/** Validate the bounded worker reply independently without revalidating 100,000 channels on UI. */
export function validateAutomaticGuideCapture(input: unknown): AutomaticGuideCapture {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('The program guide capture reply is invalid.');
  const value = input as Record<string, unknown>;
  if (
    typeof value.catalogRevision !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value.catalogRevision) ||
    BigInt(value.catalogRevision) > 9223372036854775807n ||
    !Number.isSafeInteger(value.channelCount) ||
    (value.channelCount as number) < 0 ||
    (value.channelCount as number) > 100000 ||
    typeof value.automaticGuideUpdates !== 'boolean' ||
    !Array.isArray(value.aliases) ||
    value.aliases.length > 1 ||
    (value.catalogCountries !== undefined &&
      (!Array.isArray(value.catalogCountries) ||
        value.catalogCountries.length > 300 ||
        value.catalogCountries.some(
          (code: unknown) => typeof code !== 'string' || !/^[A-Z]{2}$/.test(code),
        ))) ||
    !boundedUtf8Text(JSON.stringify(value), 8 * 1024 * 1024)
  )
    throw new Error('The program guide capture reply is invalid.');
  const sources = validateCatalog({
    schemaVersion: 1,
    sources: value.sources,
    channels: [],
  }).sources;
  const registry = validateProviderRegistry({
    schemaVersion: 1,
    reviewedChannelProviders: [],
    reviewedGuideProviders: value.registry,
  }).reviewedGuideProviders;
  const preferences = validatePreferences({
    ...defaultPreferences(),
    reviewedGuideProviders: registry,
    preferredRegion: value.preferredRegion,
    automaticGuideUpdates: value.automaticGuideUpdates,
  });
  if (value.preferenceKey !== automaticGuidePreferenceKey(preferences))
    throw new Error('The program guide preference snapshot is inconsistent.');
  return {
    catalogRevision: value.catalogRevision,
    channelCount: value.channelCount as number,
    sources,
    registry,
    preferredRegion: preferences.preferredRegion,
    automaticGuideUpdates: preferences.automaticGuideUpdates !== false,
    preferenceKey: value.preferenceKey as string,
    aliases: value.aliases.map(validateReviewedGuideAliases),
    ...(Array.isArray(value.catalogCountries)
      ? { catalogCountries: [...(value.catalogCountries as string[])] }
      : {}),
  };
}
