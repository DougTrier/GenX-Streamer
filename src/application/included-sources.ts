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

import { validateSource, type CatalogRecord, type Source } from '../catalog';
import type { Preferences } from '../preferences';

const href = (location: string) => new URL(location).href;

/** Saved URL sources plus included (discovered) providers, as one scan's sources. */
export function providerScanSources(catalog: CatalogRecord, settings: Preferences): Source[] {
  const sources = catalog.sources
    .filter((source) => source.kind === 'url')
    .map((source) => ({ ...source }));
  const locations = new Set(sources.map((source) => href(source.location)));
  for (const provider of settings.reviewedChannelProviders ?? []) {
    if (locations.has(provider.location)) continue;
    if (sources.length >= 100)
      throw new Error('Keep at most 100 saved and discovery sources for one scan.');
    sources.push(
      validateSource({
        id: provider.id,
        name: provider.name,
        location: provider.location,
        kind: 'url',
        allowHttp: provider.allowHttp ?? false,
      }),
    );
    locations.add(provider.location);
  }
  return sources;
}

/**
 * Owner decision, October 17, 2026: included Free TV sources allow plain HTTP
 * channels, as Paid TV accounts do with their checkbox. About half of the
 * included HTTP channels respond with live video. Custom sources keep their own
 * "Allow unencrypted HTTP" choice. Returns the records to write, or null when
 * every included provider and its saved source already allow HTTP.
 */
export function allowIncludedHttp(
  catalog: CatalogRecord,
  preferences: Preferences,
): { catalog: CatalogRecord; preferences: Preferences } | null {
  const providers = preferences.reviewedChannelProviders ?? [];
  const included = new Set(providers.map((provider) => href(provider.location)));
  const allow = <T extends Source>(source: T): T =>
    source.kind === 'url' && source.allowHttp !== true && included.has(href(source.location))
      ? { ...source, allowHttp: true }
      : source;
  const sources = catalog.sources.map(allow);
  const savedSources = preferences.sources.map(allow);
  const nextProviders = providers.map((provider) =>
    provider.allowHttp === true ? provider : { ...provider, allowHttp: true },
  );
  if (
    sources.every((source, i) => source === catalog.sources[i]) &&
    savedSources.every((source, i) => source === preferences.sources[i]) &&
    nextProviders.every((provider, i) => provider === providers[i])
  )
    return null;
  return {
    catalog: { ...catalog, sources },
    preferences: { ...preferences, sources: savedSources, reviewedChannelProviders: nextProviders },
  };
}
