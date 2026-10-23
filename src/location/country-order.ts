import data from './country-population.json';
const population: Readonly<Record<string, number>> = data.population;
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/**
 * English-speaking countries come first (owner request, October 19, 2026):
 * the majority English-speaking countries in this fixed order (US first by
 * user choice), then the countries and territories where English is an
 * official or national language, by population. App codes: UK, not GB.
 */
export const ENGLISH_FIRST: readonly string[] = ['US', 'CA', 'UK', 'AU', 'NZ', 'IE'];
export const ENGLISH_OFFICIAL: ReadonlySet<string> = new Set(
  (
    'IN PK NG PH ZA KE UG GH CM ZW ZM MW SL LR SS RW BW NA LS SZ GM SD JM TT BS BB BZ GY AG ' +
    'DM GD KN LC VC SG MT FJ PG SB VU WS TO KI TV NR PW MH FM MU SC PR GU VI AS MP BM KY VG ' +
    'AI MS TC GI IM JE GG FK SH CK NU NF CX CC PN UM IO'
  ).split(' '),
);
/** 0: majority English, 1: English official, 2: every other country. */
export function englishTier(code: string): 0 | 1 | 2 {
  return ENGLISH_FIRST.includes(code) ? 0 : ENGLISH_OFFICIAL.has(code) ? 1 : 2;
}
/** English-speaking first (see above); within a group known populations descend, unavailable areas follow by name. */
export function compareCountryCodes(
  a: string,
  b: string,
  name: (code: string) => string = (code) => code,
): number {
  if (a === b) return 0;
  const tierA = englishTier(a),
    tierB = englishTier(b);
  if (tierA !== tierB) return tierA - tierB;
  if (tierA === 0) return ENGLISH_FIRST.indexOf(a) - ENGLISH_FIRST.indexOf(b);
  const left = population[a],
    right = population[b];
  if (left !== undefined && right !== undefined && left !== right) return right - left;
  if (left !== undefined && right === undefined) return -1;
  if (right !== undefined && left === undefined) return 1;
  return (
    lexical(name(a).normalize('NFKC').toLowerCase(), name(b).normalize('NFKC').toLowerCase()) ||
    lexical(a, b)
  );
}
export function orderCountries<T extends { code: string; name: string }>(
  countries: readonly T[],
): T[] {
  const names = new Map(countries.map((country) => [country.code, country.name]));
  return [...countries].sort((a, b) =>
    compareCountryCodes(a.code, b.code, (code) => names.get(code) ?? code),
  );
}
