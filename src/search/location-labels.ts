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

import countries from '../location/countries.json';
import subdivisions from './subdivisions.json';
import type { ChannelGeography, GeographyRegistry } from '../catalog/geography';

const countryNames = new Map(countries.map((country) => [country.code, country.name]));
const stateNames: Readonly<Record<string, string>> = subdivisions.labels;
/** Only admitted geographic codes and published labels are indexed; no city/station inference. */
export function locationSearchText(
  geography?: ChannelGeography,
  registry?: GeographyRegistry | null,
): string {
  if (!geography) return '';
  const parts: string[] = [];
  if (geography.country) {
    const code = geography.country;
    const supplied = registry?.countries.get(code);
    parts.push(code, supplied && supplied !== code ? supplied : (countryNames.get(code) ?? code));
  }
  if (geography.state) {
    const code = geography.state;
    const supplied = registry?.states.get(code)?.name;
    parts.push(code, supplied && supplied !== code ? supplied : (stateNames[code] ?? code));
  }
  if (geography.region)
    parts.push(geography.region, registry?.regions.get(geography.region)?.name ?? geography.region);
  return parts.join(' ').normalize('NFKC').toLowerCase();
}
