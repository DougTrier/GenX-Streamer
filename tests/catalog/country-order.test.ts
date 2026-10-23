import { expect, it } from 'vitest';
import countries from '../../src/location/countries.json';
import population from '../../src/location/country-population.json';
import {
  compareCountryCodes,
  englishTier,
  orderCountries,
} from '../../src/location/country-order';
it('puts English-speaking countries first, then orders the rest by descending published population', () => {
  const ordered = orderCountries(countries);
  // Owner request: the majority English-speaking countries first, US first.
  expect(ordered.slice(0, 6).map((country) => country.code)).toEqual([
    'US',
    'CA',
    'UK',
    'AU',
    'NZ',
    'IE',
  ]);
  // Then countries where English is official, by population.
  expect(ordered.slice(6, 10).map((country) => country.code)).toEqual(['IN', 'PK', 'NG', 'PH']);
  expect(ordered).toHaveLength(countries.length);
  expect(new Set(ordered.map((country) => country.code))).toEqual(
    new Set(countries.map((country) => country.code)),
  );
  const values: Readonly<Record<string, number>> = population.population;
  const tiers = ordered.map((country) => englishTier(country.code));
  for (let index = 1; index < tiers.length; index++)
    expect(tiers[index - 1]!).toBeLessThanOrEqual(tiers[index]!);
  for (const tier of [1, 2] as const) {
    const known = ordered.filter(
      (country) => englishTier(country.code) === tier && values[country.code] !== undefined,
    );
    for (let index = 1; index < known.length; index++)
      expect(values[known[index - 1].code]!).toBeGreaterThanOrEqual(values[known[index].code]!);
  }
  // Every other country keeps population order: China first among them.
  expect(ordered.find((country) => englishTier(country.code) === 2)?.code).toBe('CN');
  expect(population.indicator).toBe('SP.POP.TOTL');
  expect(population.year).toBe(2024);
  expect(population.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
});
it('uses deterministic named fallback for missing territories and preserves original inputs', () => {
  const input = [
    { code: 'ZZ', name: 'Zed' },
    { code: 'CN', name: 'China' },
    { code: 'XY', name: 'Alpha' },
    { code: 'US', name: 'United States' },
  ];
  const before = structuredClone(input);
  expect(orderCountries(input).map((country) => country.code)).toEqual(['US', 'CN', 'XY', 'ZZ']);
  expect(input).toEqual(before);
  expect(compareCountryCodes('UK', 'FR')).toBeLessThan(0);
  expect(compareCountryCodes('US', 'US')).toBe(0);
});
