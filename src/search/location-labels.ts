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
