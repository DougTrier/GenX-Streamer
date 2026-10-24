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

import type { AutomaticGuideProvider } from './automatic-build';

/** Country of a recognized per-country published directory file; never constructed. */
export function guideFeedCountry(location: string): string | undefined {
  let path: string;
  try {
    path = new URL(location).pathname;
  } catch {
    return undefined;
  }
  return /\/epg_ripper_([A-Z]{2})(?:_[A-Z]+)?[0-9]+\.xml(?:\.gz)?$/.exec(path)?.[1];
}

/** Ordering evidence only: these labels never grant a mapping, network permission or new URL. */
export function prioritizeGuideProviders<T extends AutomaticGuideProvider>(
  providers: readonly T[],
  preferredCountry: string | undefined,
  playlistLocations: ReadonlySet<string>,
): T[] {
  const country = preferredCountry?.toUpperCase();
  const rank = (provider: T): number => {
    if (playlistLocations.has(provider.location)) return 0;
    if (!country || !/^[A-Z]{2}$/.test(country)) return 2;
    const path = new URL(provider.location).pathname;
    // Recognized published directory filenames; no suffix or URL is constructed.
    const directoryCountry = /\/epg_ripper_([A-Z]{2})(?:_[A-Z]+)?[0-9]+\.xml(?:\.gz)?$/.exec(
      path,
    )?.[1];
    if (directoryCountry === country) return 1;
    if (
      country === 'US' &&
      (/^\/acidjesuz\/EPGTalk\/master\/US_(?:local_guide|lite)\.xml\.gz$/.test(path) ||
        path === '/matthuisman/i.mjh.nz/master/PlutoTV/us.xml.gz')
    )
      return 1;
    // A combined worldwide file is not a regional shortcut; try specific sources first.
    if (/\/epg_ripper_ALL_SOURCES[0-9]+\.xml(?:\.gz)?$/.test(path)) return 3;
    return 2;
  };
  return providers
    .map((provider, index) => ({ provider, index, rank: rank(provider) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ provider }) => provider);
}
