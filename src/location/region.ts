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

import { validateGeographyShape, type ChannelGeography } from '../catalog/geography';

export interface PreferredRegion {
  country: string;
  state?: string;
  postal?: string;
  origin: 'manual' | 'ip';
}

/** The catalog provider uses UK; auxiliary location services use ISO GB. */
export function postalServiceCountry(country: string): string {
  return country === 'UK' ? 'gb' : country.toLowerCase();
}

const catalogCountry = (country: string) => (country === 'GB' ? 'UK' : country);

export function regionFromPostalResponse(
  text: string,
  country: string,
  postal: string,
): PreferredRegion {
  if (new TextEncoder().encode(text).length > 32_768)
    throw new Error('Location response is too large.');
  const data = JSON.parse(text) as { 'country abbreviation'?: unknown; places?: unknown };
  if (
    !data ||
    typeof data['country abbreviation'] !== 'string' ||
    catalogCountry(data['country abbreviation']) !== country ||
    !Array.isArray(data.places) ||
    !data.places.length
  )
    throw new Error('Postal code could not be matched.');
  const states = new Set(
    data.places.map((place: Record<string, unknown>) => place?.['state abbreviation']),
  );
  const stateCode = states.size === 1 ? [...states][0] : undefined;
  const state =
    typeof stateCode === 'string' && /^[A-Z0-9]{1,8}$/.test(stateCode)
      ? `${country}-${stateCode}`
      : undefined;
  const geography = validateGeographyShape({ country, ...(state ? { state } : {}) });
  return { country: geography.country!, ...(state ? { state } : {}), postal, origin: 'manual' };
}

/** IP responses suggest a region; addresses, coordinates and postal codes are not retained. */
export function regionFromIpResponse(text: string): PreferredRegion {
  if (new TextEncoder().encode(text).length > 32_768)
    throw new Error('Location response is too large.');
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Location response is invalid.');
  const record = data as Record<string, unknown>;
  if (record.error || typeof record.country_code !== 'string')
    throw new Error('Location could not be determined.');
  const country = catalogCountry(record.country_code.toUpperCase());
  const state =
    typeof record.region_code === 'string' && record.region_code
      ? `${country}-${record.region_code.toUpperCase()}`
      : undefined;
  const geography = validateGeographyShape({ country, ...(state ? { state } : {}) });
  return {
    country: geography.country!,
    ...(geography.state ? { state: geography.state } : {}),
    origin: 'ip',
  };
}

/** Stable ordering only: missing geography never becomes an inferred station location. */
export function prioritizeRegion<T>(
  items: readonly T[],
  region: PreferredRegion | undefined,
  geography: (item: T) => ChannelGeography | undefined,
): T[] {
  const rank = (item: T): number => {
    const declared = geography(item);
    if (!region || !declared?.country) return 3;
    if (region.state && declared.state === region.state) return 0;
    if (declared.country === region.country) return 1;
    return 2;
  };
  return items
    .map((item, ordinal) => ({ item, ordinal, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.ordinal - b.ordinal)
    .map(({ item }) => item);
}
