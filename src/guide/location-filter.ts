// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { MAX_FILTER_COUNTRIES, type GeographyFilter } from '../catalog/geography';

/** Snapshot the channel list's declared location; never infer it from names. */
export function captureGuideLocation(scope: GeographyFilter = {}): GeographyFilter {
  const invalid = () => new Error('The program guide location filter is invalid.');
  if (
    !scope ||
    typeof scope !== 'object' ||
    Array.isArray(scope) ||
    Object.keys(scope).some((key) => !['country', 'countries', 'region', 'state'].includes(key))
  )
    throw invalid();
  const code = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Z0-9_-]{1,32}$/.test(value);
  if (scope.countries !== undefined) {
    if (
      !Array.isArray(scope.countries) ||
      scope.countries.length < 2 ||
      scope.countries.length > MAX_FILTER_COUNTRIES ||
      !scope.countries.every(code) ||
      new Set(scope.countries).size !== scope.countries.length ||
      ['country', 'region', 'state'].some(
        (field) => scope[field as 'country' | 'region' | 'state'] !== undefined,
      )
    )
      throw invalid();
    return { countries: [...scope.countries].sort() };
  }
  const captured: GeographyFilter = {};
  for (const field of ['country', 'region', 'state'] as const) {
    const value = scope[field];
    if (value === undefined) continue;
    if (value !== null && !code(value)) throw invalid();
    captured[field] = value;
  }
  return captured;
}

/** A view scope, separate from the persisted numeric catalog revision. */
export const guideLocationKey = (scope: GeographyFilter = {}): string =>
  JSON.stringify(captureGuideLocation(scope));
