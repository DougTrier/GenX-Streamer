/** Optional codes; absent fields are Unknown, never inferred from names or network hosts. */
export interface ChannelGeography {
  country?: string;
  region?: string;
  state?: string;
}
export interface GeographyData {
  countries: readonly { code: string; name: string }[];
  regions: readonly { code: string; name: string; countries: readonly string[] }[];
  states: readonly { code: string; name: string; country: string }[];
}
export interface GeographyRegistry {
  countries: ReadonlyMap<string, string>;
  regions: ReadonlyMap<string, { name: string; countries: readonly string[] }>;
  states: ReadonlyMap<string, { name: string; country: string }>;
}
type Field = keyof ChannelGeography;
export interface GeographyProvenance {
  field: Field;
  value: string;
  sourceId: string;
  providerId?: string;
  kind: 'provider' | 'm3u' | 'registry' | 'user';
  scope: 'channel-origin' | 'provider-declared' | 'country-group' | 'user-reviewed';
}
export interface GeographyResolution {
  geography: ChannelGeography;
  provenance: GeographyProvenance[];
  issues: (
    | 'unknown-country'
    | 'unknown-region'
    | 'unknown-state'
    | 'multiple-countries'
    | 'provider-mismatch'
    | 'inconsistent-geography'
    | 'ambiguous-region'
  )[];
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const fold = (value: string) => value.normalize('NFC').toLowerCase();
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function text(value: unknown, max = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}
function code(value: string): string {
  return value.trim().toUpperCase();
}
/** Canonical code syntax without claiming membership in any fetched provider dataset. */
export function validateGeographyShape(raw: unknown): ChannelGeography {
  if (!plain(raw) || Object.keys(raw).some((key) => !['country', 'region', 'state'].includes(key)))
    throw new Error('Channel geography is invalid.');
  const result: ChannelGeography = {};
  for (const field of ['country', 'region', 'state'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    const pattern =
      field === 'country'
        ? /^[A-Z]{2}$/
        : field === 'state'
          ? /^[A-Z]{2}-[A-Z0-9]{1,8}$/
          : /^[A-Z0-9_-]{1,32}$/;
    if (typeof value !== 'string' || !pattern.test(value))
      throw new Error('Channel geography contains an invalid code.');
    result[field] = value;
  }
  if (result.state && (!result.country || !result.state.startsWith(result.country + '-')))
    throw new Error('Channel subdivision does not match its country.');
  return result;
}
export function validateGeographyProvenance(
  raw: unknown,
  geography: ChannelGeography,
  sourceId: string,
): GeographyProvenance[] {
  if (!Array.isArray(raw) || raw.length > 3) throw new Error('Invalid geography provenance.');
  const fields = new Set<string>();
  return raw.map((value) => {
    if (
      !plain(value) ||
      !['country', 'region', 'state'].includes(String(value.field)) ||
      fields.has(String(value.field)) ||
      value.sourceId !== sourceId ||
      !text(value.value, 32) ||
      geography[value.field as Field] !== value.value ||
      !['provider', 'm3u', 'registry', 'user'].includes(String(value.kind)) ||
      !['channel-origin', 'provider-declared', 'country-group', 'user-reviewed'].includes(
        String(value.scope),
      ) ||
      (value.providerId !== undefined && !text(value.providerId, 16384))
    )
      throw new Error('Invalid geography provenance.');
    fields.add(String(value.field));
    return {
      field: value.field as Field,
      value: value.value,
      sourceId,
      kind: value.kind as GeographyProvenance['kind'],
      scope: value.scope as GeographyProvenance['scope'],
      ...(value.providerId !== undefined ? { providerId: value.providerId as string } : {}),
    };
  });
}
export function parseDeclaredGeography(
  sourceId: string,
  providerId: string | undefined,
  attributes: ReadonlyMap<string, string>,
): {
  geography?: ChannelGeography;
  geographyProvenance?: GeographyProvenance[];
  warnings: string[];
} {
  const geography: ChannelGeography = {};
  const warnings: string[] = [];
  const country = attributes.get('tvg-country')?.trim().toUpperCase();
  if (country) {
    if (/^[A-Z]{2}$/.test(country)) geography.country = country;
    else warnings.push('Country declaration is ambiguous or invalid; country remains Unknown.');
  }
  const state = attributes.get('tvg-state')?.trim().toUpperCase();
  if (state) {
    if (
      /^[A-Z]{2}-[A-Z0-9]{1,8}$/.test(state) &&
      (!country || (geography.country && state.startsWith(geography.country + '-')))
    ) {
      geography.country ??= state.slice(0, 2);
      geography.state = state;
    } else
      warnings.push('Subdivision declaration is inconsistent or invalid; state remains Unknown.');
  }
  const region = attributes.get('tvg-region')?.trim().toUpperCase();
  if (region) {
    if (/^[A-Z0-9_-]{1,32}$/.test(region)) geography.region = region;
    else warnings.push('Region declaration is invalid; region remains Unknown.');
  }
  const fields = Object.entries(geography) as [Field, string][];
  return {
    ...(fields.length
      ? {
          geography,
          geographyProvenance: fields.map(([field, value]) => ({
            field,
            value,
            sourceId,
            ...(providerId ? { providerId } : {}),
            kind: 'm3u' as const,
            scope: 'provider-declared' as const,
          })),
        }
      : {}),
    warnings,
  };
}
export function createGeographyRegistry(data: GeographyData): GeographyRegistry {
  if (data.countries.length > 1000 || data.regions.length > 1000 || data.states.length > 10000)
    throw new Error('Geographic metadata exceeds its limit.');
  const countries = new Map<string, string>();
  const regions = new Map<string, { name: string; countries: readonly string[] }>();
  const states = new Map<string, { name: string; country: string }>();
  for (const entry of data.countries) {
    if (!/^[A-Z]{2}$/.test(entry.code) || !text(entry.name) || countries.has(entry.code))
      throw new Error('Country metadata is invalid.');
    countries.set(entry.code, entry.name);
  }
  for (const entry of data.regions) {
    if (
      !/^[A-Z0-9_-]{1,32}$/.test(entry.code) ||
      !text(entry.name) ||
      regions.has(entry.code) ||
      entry.countries.length > 1000 ||
      entry.countries.some((country) => !countries.has(country)) ||
      new Set(entry.countries).size !== entry.countries.length
    )
      throw new Error('Region metadata is invalid.');
    regions.set(entry.code, { name: entry.name, countries: [...entry.countries] });
  }
  for (const entry of data.states) {
    if (
      !/^[A-Z]{2}-[A-Z0-9]{1,8}$/.test(entry.code) ||
      !entry.code.startsWith(entry.country + '-') ||
      !countries.has(entry.country) ||
      !text(entry.name) ||
      states.has(entry.code)
    )
      throw new Error('Subdivision metadata is invalid.');
    states.set(entry.code, { name: entry.name, country: entry.country });
  }
  return { countries, regions, states };
}
/** Strict boundary for canonical/imported records. A registry is injected, never downloaded here. */
export function validateGeography(raw: unknown, registry: GeographyRegistry): ChannelGeography {
  if (!plain(raw) || Object.keys(raw).some((key) => !['country', 'region', 'state'].includes(key)))
    throw new Error('Channel geography is invalid.');
  const result: ChannelGeography = {};
  for (const field of ['country', 'region', 'state'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (
      !text(value, 32) ||
      value !== code(value) ||
      !registry[field === 'country' ? 'countries' : field === 'region' ? 'regions' : 'states'].has(
        value,
      )
    )
      throw new Error('Channel geography contains an unrecognized code.');
    result[field] = value;
  }
  if (
    result.state &&
    (!result.country || registry.states.get(result.state)?.country !== result.country)
  )
    throw new Error('Channel subdivision does not match its country.');
  if (
    result.country &&
    result.region &&
    !registry.regions.get(result.region)?.countries.includes(result.country)
  )
    throw new Error('Channel region does not match its country.');
  return result;
}
export interface ProviderGeographyInput {
  sourceId: string;
  providerId?: string;
  /** Exact externally resolved channel ID; no name, suffix or URL match. */
  providerChannel?: { id: string; country: string };
  attributes?: Readonly<Record<string, string>>;
}
export function resolveProviderGeography(
  input: ProviderGeographyInput,
  registry: GeographyRegistry,
): GeographyResolution {
  if (!text(input.sourceId) || (input.providerId !== undefined && !text(input.providerId, 16384)))
    throw new Error('Geographic source identity is invalid.');
  const geography: ChannelGeography = {};
  const provenance: GeographyProvenance[] = [];
  const issues: GeographyResolution['issues'] = [];
  function record(
    field: Field,
    value: string,
    kind: GeographyProvenance['kind'],
    scope: GeographyProvenance['scope'],
  ): void {
    geography[field] = value;
    provenance.push({
      field,
      value,
      sourceId: input.sourceId,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      kind,
      scope,
    });
  }
  if (input.providerChannel) {
    if (input.providerChannel.id !== input.providerId) issues.push('provider-mismatch');
    else if (!registry.countries.has(code(input.providerChannel.country)))
      issues.push('unknown-country');
    else record('country', code(input.providerChannel.country), 'provider', 'channel-origin');
  }
  const attributes = input.attributes ?? {};
  const rawCountry = attributes['tvg-country'];
  if (rawCountry) {
    if (!text(rawCountry, 256)) throw new Error('Geographic attribute exceeds its limit.');
    const tokens = [...new Set(rawCountry.split(';').map(code))];
    if (tokens.length !== 1) issues.push('multiple-countries');
    else if (!registry.countries.has(tokens[0]!)) issues.push('unknown-country');
    else if (!geography.country) record('country', tokens[0]!, 'm3u', 'provider-declared');
    else if (geography.country !== tokens[0]) issues.push('inconsistent-geography');
  }
  const rawState = attributes['tvg-state'];
  if (rawState) {
    if (!text(rawState, 32)) throw new Error('Geographic attribute exceeds its limit.');
    const state = registry.states.get(code(rawState));
    if (!state) issues.push('unknown-state');
    else if (geography.country && state.country !== geography.country)
      issues.push('inconsistent-geography');
    else {
      if (!geography.country) record('country', state.country, 'm3u', 'provider-declared');
      record('state', code(rawState), 'm3u', 'provider-declared');
    }
  }
  const rawRegion = attributes['tvg-region'];
  if (rawRegion) {
    if (!text(rawRegion, 32)) throw new Error('Geographic attribute exceeds its limit.');
    const region = registry.regions.get(code(rawRegion));
    if (!region) issues.push('unknown-region');
    else if (geography.country && !region.countries.includes(geography.country))
      issues.push('inconsistent-geography');
    else record('region', code(rawRegion), 'm3u', 'provider-declared');
  } else if (geography.country) {
    const matches = [...registry.regions].filter(([, value]) =>
      value.countries.includes(geography.country!),
    );
    if (matches.length === 1) record('region', matches[0]![0], 'registry', 'country-group');
    else if (matches.length > 1) issues.push('ambiguous-region');
  }
  return { geography: validateGeography(geography, registry), provenance, issues };
}
export interface GeographicChannel {
  id: string;
  sourceId: string;
  name: string;
  geography?: ChannelGeography;
}
export type GeographyFilter = Partial<Record<Field, string | null>> & {
  /** Any of these countries (two or more chosen); then country, region and state are absent. */
  readonly countries?: readonly string[];
};
/** Most countries one view can combine. */
export const MAX_FILTER_COUNTRIES = 64;
/** undefined = All, null = Unknown. Exact codes preserve source/identity independence. */
export function matchesGeography(
  channel: Omit<GeographicChannel, 'sourceId'> & { sourceId?: string },
  filter: GeographyFilter,
): boolean {
  if (filter.countries !== undefined) {
    const country = channel.geography?.country;
    if (country === undefined || !filter.countries.includes(country)) return false;
  }
  return (['country', 'region', 'state'] as const).every(
    (field) =>
      filter[field] === undefined ||
      (filter[field] === null
        ? channel.geography?.[field] === undefined
        : channel.geography?.[field] === filter[field]),
  );
}
export function geographyLabel(
  field: Field,
  value: string | undefined,
  registry: GeographyRegistry,
  unknownLabel = 'Unknown',
): string {
  if (value === undefined) return unknownLabel;
  if (field === 'country') return registry.countries.get(value) ?? unknownLabel;
  return (
    (field === 'region' ? registry.regions.get(value) : registry.states.get(value))?.name ??
    unknownLabel
  );
}
/** Known values precede Unknown; code tie-breaks disambiguate identical translated labels. */
export function compareGeographicChannels(
  a: Omit<GeographicChannel, 'sourceId'> & { sourceId?: string },
  b: Omit<GeographicChannel, 'sourceId'> & { sourceId?: string },
  registry: GeographyRegistry,
): number {
  for (const field of ['country', 'region', 'state'] as const) {
    const left = a.geography?.[field],
      right = b.geography?.[field];
    if (left === undefined && right !== undefined) return 1;
    if (right === undefined && left !== undefined) return -1;
    if (left !== undefined && right !== undefined) {
      const order =
        compare(
          fold(geographyLabel(field, left, registry)),
          fold(geographyLabel(field, right, registry)),
        ) || compare(left, right);
      if (order) return order;
    }
  }
  return (
    compare(fold(a.name), fold(b.name)) ||
    compare(a.name, b.name) ||
    compare(a.sourceId ?? '', b.sourceId ?? '') ||
    compare(a.id, b.id)
  );
}
